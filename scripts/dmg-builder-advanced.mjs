#!/usr/bin/env node

/**
 * Advanced DMG Builder with multiple strategies and background queue
 * Supports create-dmg, hdiutil, and appdmg as fallback options
 */

import { exec, execSync, spawn } from 'child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import PQueue from 'p-queue';

const execAsync = promisify(exec);
const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

// Strategy definitions
const STRATEGIES = {
  CREATE_DMG: 'create-dmg',
  HDIUTIL: 'hdiutil',
  APPDMG: 'appdmg',
  ELECTRON_BUILDER: 'electron-builder'
};

// Build telemetry storage
const TELEMETRY_FILE = join(projectRoot, '.build-telemetry.json');

class BuildTelemetry {
  constructor() {
    this.data = this.load();
  }

  load() {
    try {
      if (existsSync(TELEMETRY_FILE)) {
        return JSON.parse(readFileSync(TELEMETRY_FILE, 'utf8'));
      }
    } catch (error) {
      console.error('Failed to load telemetry:', error.message);
    }
    return {
      builds: [],
      strategies: {
        [STRATEGIES.CREATE_DMG]: { attempts: 0, successes: 0, avgTime: 0 },
        [STRATEGIES.HDIUTIL]: { attempts: 0, successes: 0, avgTime: 0 },
        [STRATEGIES.APPDMG]: { attempts: 0, successes: 0, avgTime: 0 },
        [STRATEGIES.ELECTRON_BUILDER]: { attempts: 0, successes: 0, avgTime: 0 }
      }
    };
  }

  save() {
    try {
      writeFileSync(TELEMETRY_FILE, JSON.stringify(this.data, null, 2));
    } catch (error) {
      console.error('Failed to save telemetry:', error.message);
    }
  }

  recordBuild(strategy, success, duration, error = null) {
    const build = {
      timestamp: new Date().toISOString(),
      strategy,
      success,
      duration,
      error: error ? error.message : null,
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version
    };

    this.data.builds.push(build);

    // Keep only last 100 builds
    if (this.data.builds.length > 100) {
      this.data.builds = this.data.builds.slice(-100);
    }

    // Update strategy stats
    const stats = this.data.strategies[strategy];
    stats.attempts++;
    if (success) {
      stats.successes++;
      // Update average time
      const successfulBuilds = this.data.builds.filter(b =>
        b.strategy === strategy && b.success
      );
      const avgTime = successfulBuilds.reduce((sum, b) => sum + b.duration, 0) / successfulBuilds.length;
      stats.avgTime = Math.round(avgTime);
    }

    this.save();
  }

  getBestStrategy() {
    // Calculate success rate for each strategy
    const strategies = Object.entries(this.data.strategies)
      .map(([name, stats]) => ({
        name,
        successRate: stats.attempts > 0 ? stats.successes / stats.attempts : 0,
        avgTime: stats.avgTime,
        attempts: stats.attempts
      }))
      .filter(s => s.attempts > 0)
      .sort((a, b) => {
        // Prefer higher success rate
        if (Math.abs(a.successRate - b.successRate) > 0.1) {
          return b.successRate - a.successRate;
        }
        // If similar success rate, prefer faster
        return a.avgTime - b.avgTime;
      });

    return strategies[0]?.name || STRATEGIES.CREATE_DMG;
  }

  getReport() {
    const totalBuilds = this.data.builds.length;
    const successfulBuilds = this.data.builds.filter(b => b.success).length;
    const overallSuccessRate = totalBuilds > 0 ?
      ((successfulBuilds / totalBuilds) * 100).toFixed(1) : 0;

    console.log('\n📊 Build Telemetry Report:');
    console.log(`├─ Total builds: ${totalBuilds}`);
    console.log(`├─ Success rate: ${overallSuccessRate}%`);
    console.log(`└─ Strategy performance:`);

    Object.entries(this.data.strategies).forEach(([name, stats]) => {
      if (stats.attempts > 0) {
        const successRate = ((stats.successes / stats.attempts) * 100).toFixed(1);
        console.log(`   ├─ ${name}: ${successRate}% success, ~${stats.avgTime}ms avg`);
      }
    });

    return this.data;
  }
}

class DMGBuilder {
  constructor(config) {
    this.config = {
      appPath: config.appPath,
      outputPath: config.outputPath,
      volumeName: config.volumeName || 'Installer',
      background: config.background,
      icon: config.icon,
      windowSize: config.windowSize || { width: 540, height: 380 },
      iconSize: config.iconSize || 80,
      contents: config.contents || [
        { x: 140, y: 150, type: 'file' },
        { x: 400, y: 150, type: 'link', path: '/Applications' }
      ],
      format: config.format || 'UDZO',
      maxRetries: config.maxRetries || 3,
      timeout: config.timeout || 120000
    };

    this.telemetry = new BuildTelemetry();
    this.queue = new PQueue({ concurrency: 1 });
  }

  async build() {
    console.log('🔨 Starting DMG build with advanced strategies...\n');

    // Get best strategy based on telemetry
    const bestStrategy = this.telemetry.getBestStrategy();
    console.log(`📊 Best strategy based on history: ${bestStrategy}\n`);

    // Define strategy order
    const strategyOrder = [
      bestStrategy,
      ...Object.values(STRATEGIES).filter(s => s !== bestStrategy)
    ];

    // Try each strategy
    for (const strategy of strategyOrder) {
      if (await this.tryStrategy(strategy)) {
        this.telemetry.getReport();
        return true;
      }
    }

    console.error('❌ All strategies failed');
    this.telemetry.getReport();
    return false;
  }

  async tryStrategy(strategy) {
    console.log(`\n🔧 Trying strategy: ${strategy}`);
    const startTime = Date.now();

    try {
      let success = false;

      switch (strategy) {
        case STRATEGIES.CREATE_DMG:
          success = await this.useCreateDmg();
          break;
        case STRATEGIES.HDIUTIL:
          success = await this.useHdiutil();
          break;
        case STRATEGIES.APPDMG:
          success = await this.useAppdmg();
          break;
        case STRATEGIES.ELECTRON_BUILDER:
          success = await this.useElectronBuilder();
          break;
      }

      const duration = Date.now() - startTime;

      if (success) {
        console.log(`✅ ${strategy} succeeded in ${duration}ms`);
        this.telemetry.recordBuild(strategy, true, duration);
        return true;
      } else {
        throw new Error(`${strategy} failed`);
      }
    } catch (error) {
      const duration = Date.now() - startTime;
      console.error(`❌ ${strategy} failed: ${error.message}`);
      this.telemetry.recordBuild(strategy, false, duration, error);
      return false;
    }
  }

  async useCreateDmg() {
    // Check if create-dmg is available
    try {
      execSync('which create-dmg', { stdio: 'pipe' });
    } catch {
      // Try to use npx
      console.log('create-dmg not found globally, using npx...');
    }

    const args = [
      '--volname', this.config.volumeName,
      '--window-size', `${this.config.windowSize.width} ${this.config.windowSize.height}`,
      '--icon-size', this.config.iconSize.toString(),
      '--app-drop-link', '400', '150',
    ];

    if (this.config.background) {
      args.push('--background', this.config.background);
    }

    if (this.config.icon) {
      args.push('--volicon', this.config.icon);
    }

    args.push(
      '--hide-extension', basename(this.config.appPath),
      '--no-internet-enable',
      this.config.outputPath,
      this.config.appPath
    );

    return new Promise((resolve, reject) => {
      const cmd = `npx create-dmg ${args.join(' ')}`;
      console.log(`Executing: ${cmd}`);

      const child = spawn('npx', ['create-dmg', ...args], {
        stdio: 'inherit',
        timeout: this.config.timeout
      });

      child.on('exit', (code) => {
        if (code === 0 || code === 2) { // code 2 is success for create-dmg
          resolve(true);
        } else {
          reject(new Error(`create-dmg exited with code ${code}`));
        }
      });

      child.on('error', reject);
    });
  }

  async useHdiutil() {
    // This is the existing hdiutil implementation from build-dmg-m1.mjs
    // Simplified here for brevity
    const tempDmg = this.config.outputPath.replace('.dmg', '.temp.dmg');

    try {
      // Create sparse image
      await execAsync(`hdiutil create -size 500m -fs HFS+ -volname "${this.config.volumeName}" -type SPARSE "${tempDmg}"`);

      // Mount
      const { stdout } = await execAsync(`hdiutil attach "${tempDmg}.sparseimage" -nobrowse -noverify -noautoopen`);
      const mountPoint = `/Volumes/${this.config.volumeName}`;

      // Copy app
      await execAsync(`cp -R "${this.config.appPath}" "${mountPoint}/"`);
      await execAsync(`ln -s /Applications "${mountPoint}/Applications"`);

      // Unmount
      await execAsync(`hdiutil detach "${mountPoint}" -force`);

      // Convert to compressed
      await execAsync(`hdiutil convert "${tempDmg}.sparseimage" -format ${this.config.format} -o "${this.config.outputPath}"`);

      // Cleanup
      rmSync(`${tempDmg}.sparseimage`, { force: true });

      return true;
    } catch (error) {
      // Cleanup on error
      try {
        await execAsync(`hdiutil detach "/Volumes/${this.config.volumeName}" -force`);
      } catch {}
      if (existsSync(`${tempDmg}.sparseimage`)) {
        rmSync(`${tempDmg}.sparseimage`, { force: true });
      }
      throw error;
    }
  }

  async useAppdmg() {
    // Check if appdmg is available
    try {
      execSync('which appdmg', { stdio: 'pipe' });
    } catch {
      console.log('appdmg not installed, skipping...');
      throw new Error('appdmg not available');
    }

    // Create appdmg spec file
    const spec = {
      title: this.config.volumeName,
      background: this.config.background,
      icon: this.config.icon,
      'icon-size': this.config.iconSize,
      window: {
        size: this.config.windowSize
      },
      contents: this.config.contents.map(item => {
        if (item.type === 'file') {
          return { x: item.x, y: item.y, type: 'file', path: this.config.appPath };
        } else {
          return item;
        }
      })
    };

    const specFile = this.config.outputPath.replace('.dmg', '.appdmg.json');
    writeFileSync(specFile, JSON.stringify(spec, null, 2));

    return new Promise((resolve, reject) => {
      const child = spawn('appdmg', [specFile, this.config.outputPath], {
        stdio: 'inherit',
        timeout: this.config.timeout
      });

      child.on('exit', (code) => {
        rmSync(specFile, { force: true });
        if (code === 0) {
          resolve(true);
        } else {
          reject(new Error(`appdmg exited with code ${code}`));
        }
      });

      child.on('error', (error) => {
        rmSync(specFile, { force: true });
        reject(error);
      });
    });
  }

  async useElectronBuilder() {
    // Fall back to electron-builder's DMG creation
    return new Promise((resolve, reject) => {
      const child = spawn('npx', [
        'electron-builder',
        '--mac', 'dmg',
        '--arm64',
        '--config', 'electron-builder-m1.yml'
      ], {
        stdio: 'inherit',
        cwd: projectRoot,
        timeout: this.config.timeout
      });

      child.on('exit', (code) => {
        if (code === 0 && existsSync(this.config.outputPath)) {
          resolve(true);
        } else {
          reject(new Error(`electron-builder exited with code ${code}`));
        }
      });

      child.on('error', reject);
    });
  }
}

class BackgroundDMGQueue {
  constructor() {
    this.queue = new PQueue({ concurrency: 1 });
    this.statusFile = join(projectRoot, '.dmg-build-status.json');
  }

  async addBuildJob(config) {
    const jobId = Date.now().toString();

    // Update status
    this.updateStatus(jobId, 'queued', config);

    // Add to queue
    this.queue.add(async () => {
      console.log(`\n🎯 Starting DMG build job: ${jobId}`);
      this.updateStatus(jobId, 'building', config);

      const builder = new DMGBuilder(config);

      try {
        const success = await builder.build();

        if (success) {
          this.updateStatus(jobId, 'completed', config);
          console.log(`✅ DMG build job ${jobId} completed`);
        } else {
          this.updateStatus(jobId, 'failed', config);
          console.error(`❌ DMG build job ${jobId} failed`);
        }
      } catch (error) {
        this.updateStatus(jobId, 'failed', config, error.message);
        console.error(`❌ DMG build job ${jobId} errored:`, error.message);
      }
    });

    return jobId;
  }

  updateStatus(jobId, status, config, error = null) {
    let statusData = {};

    try {
      if (existsSync(this.statusFile)) {
        statusData = JSON.parse(readFileSync(this.statusFile, 'utf8'));
      }
    } catch (error) {
      console.error('Failed to load status:', error.message);
    }

    statusData[jobId] = {
      status,
      config: {
        appPath: config.appPath,
        outputPath: config.outputPath,
        volumeName: config.volumeName
      },
      timestamp: new Date().toISOString(),
      error
    };

    writeFileSync(this.statusFile, JSON.stringify(statusData, null, 2));
  }

  async getStatus(jobId = null) {
    try {
      if (existsSync(this.statusFile)) {
        const statusData = JSON.parse(readFileSync(this.statusFile, 'utf8'));
        return jobId ? statusData[jobId] : statusData;
      }
    } catch (error) {
      console.error('Failed to load status:', error.message);
    }
    return null;
  }
}

// Main execution
async function main() {
  const args = process.argv.slice(2);

  // Parse arguments
  const appPath = args.find(arg => arg.startsWith('--app='))?.split('=')[1] ||
    join(projectRoot, 'release/mac-arm64/1Code.app');

  const outputPath = args.find(arg => arg.startsWith('--output='))?.split('=')[1] ||
    join(projectRoot, 'release/1Code-arm64.dmg');

  const background = args.find(arg => arg.startsWith('--background='))?.split('=')[1] ||
    join(projectRoot, 'build/dmg-background@2x.png');

  const async = args.includes('--async');
  const status = args.find(arg => arg.startsWith('--status='))?.split('=')[1];

  // Check status if requested
  if (status) {
    const queue = new BackgroundDMGQueue();
    const statusData = await queue.getStatus(status === 'all' ? null : status);
    console.log(JSON.stringify(statusData, null, 2));
    return;
  }

  // Check if app exists
  if (!existsSync(appPath)) {
    console.error(`❌ App not found: ${appPath}`);
    process.exit(1);
  }

  const config = {
    appPath,
    outputPath,
    volumeName: '1Code',
    background: existsSync(background) ? background : null,
    icon: join(projectRoot, 'build/icon.icns')
  };

  if (async) {
    // Queue the build
    const queue = new BackgroundDMGQueue();
    const jobId = await queue.addBuildJob(config);
    console.log(`📋 DMG build queued with job ID: ${jobId}`);
    console.log(`Check status with: node scripts/dmg-builder-advanced.mjs --status=${jobId}`);
  } else {
    // Build synchronously
    const builder = new DMGBuilder(config);
    const success = await builder.build();
    process.exit(success ? 0 : 1);
  }
}

// Handle termination
process.on('SIGINT', () => {
  console.log('\nInterrupted, cleaning up...');
  process.exit(130);
});

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

export { DMGBuilder, BackgroundDMGQueue, BuildTelemetry };