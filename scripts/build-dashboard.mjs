#!/usr/bin/env node

/**
 * Build Dashboard
 * Comprehensive view of build status, telemetry, and recommendations
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

const TELEMETRY_FILE = join(projectRoot, '.build-telemetry.json');
const STATUS_FILE = join(projectRoot, '.dmg-build-status.json');
const RECOMMENDATIONS_FILE = join(projectRoot, '.build-recommendations.json');

class BuildDashboard {
  constructor() {
    this.telemetry = this.loadJSON(TELEMETRY_FILE);
    this.status = this.loadJSON(STATUS_FILE);
    this.recommendations = [];
  }

  loadJSON(file) {
    try {
      if (existsSync(file)) {
        return JSON.parse(readFileSync(file, 'utf8'));
      }
    } catch (error) {
      console.error(`Failed to load ${file}:`, error.message);
    }
    return {};
  }

  analyze() {
    console.log('\n🎯 1Code Build Dashboard\n');
    console.log('='.repeat(70));

    this.analyzeSystemInfo();
    this.analyzeBuildHistory();
    this.analyzeStrategies();
    this.analyzeErrors();
    this.generateRecommendations();
    this.showRecommendations();
  }

  analyzeSystemInfo() {
    console.log('\n📱 System Information');
    console.log('─'.repeat(70));

    const arch = process.arch;
    const platform = process.platform;
    const nodeVersion = process.version;
    const isAppleSilicon = platform === 'darwin' && arch === 'arm64';

    console.log(`Platform: ${platform} (${arch})`);
    console.log(`Node.js: ${nodeVersion}`);
    console.log(`Apple Silicon: ${isAppleSilicon ? '✅ Yes' : '❌ No'}`);

    // Check for required tools
    const tools = {
      'electron-builder': this.checkTool('electron-builder --version'),
      'create-dmg': this.checkTool('which create-dmg'),
      'hdiutil': this.checkTool('which hdiutil'),
      'appdmg': this.checkTool('which appdmg')
    };

    console.log('\nAvailable Tools:');
    Object.entries(tools).forEach(([name, available]) => {
      console.log(`  ${available ? '✅' : '❌'} ${name}`);
    });

    // System recommendations
    if (!isAppleSilicon) {
      this.recommendations.push({
        priority: 'HIGH',
        message: 'Not running on Apple Silicon - DMG creation may be more stable but slower'
      });
    }

    if (!tools['create-dmg']) {
      this.recommendations.push({
        priority: 'MEDIUM',
        message: 'Install create-dmg for better DMG creation: npm install -g create-dmg'
      });
    }
  }

  checkTool(command) {
    try {
      execSync(command, { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  analyzeBuildHistory() {
    console.log('\n📊 Build History Analysis');
    console.log('─'.repeat(70));

    if (!this.telemetry.builds || this.telemetry.builds.length === 0) {
      console.log('No build history available');
      return;
    }

    const builds = this.telemetry.builds;
    const totalBuilds = builds.length;
    const successfulBuilds = builds.filter(b => b.success).length;
    const failedBuilds = totalBuilds - successfulBuilds;
    const successRate = ((successfulBuilds / totalBuilds) * 100).toFixed(1);

    // Time analysis
    const last24h = builds.filter(b =>
      new Date(b.timestamp) > new Date(Date.now() - 24 * 60 * 60 * 1000)
    );
    const last24hSuccess = last24h.filter(b => b.success).length;
    const last24hRate = last24h.length > 0 ?
      ((last24hSuccess / last24h.length) * 100).toFixed(1) : 0;

    console.log(`Total Builds: ${totalBuilds}`);
    console.log(`├─ Successful: ${successfulBuilds} (${successRate}%)`);
    console.log(`└─ Failed: ${failedBuilds}`);
    console.log(`\nLast 24 Hours: ${last24h.length} builds`);
    console.log(`└─ Success Rate: ${last24hRate}%`);

    // Trend analysis
    if (builds.length >= 10) {
      const recentBuilds = builds.slice(-10);
      const olderBuilds = builds.slice(-20, -10);

      const recentRate = (recentBuilds.filter(b => b.success).length / recentBuilds.length) * 100;
      const olderRate = olderBuilds.length > 0 ?
        (olderBuilds.filter(b => b.success).length / olderBuilds.length) * 100 : recentRate;

      const trend = recentRate - olderRate;
      const trendIcon = trend > 0 ? '📈' : trend < 0 ? '📉' : '→';

      console.log(`\nTrend: ${trendIcon} ${trend > 0 ? '+' : ''}${trend.toFixed(1)}% from previous period`);
    }

    // Recommendations based on history
    if (successRate < 50) {
      this.recommendations.push({
        priority: 'HIGH',
        message: 'Low success rate detected - consider using ZIP-only builds for critical releases'
      });
    }

    if (last24hRate < 30 && last24h.length > 3) {
      this.recommendations.push({
        priority: 'HIGH',
        message: 'Recent build failures increasing - system may need cleanup or restart'
      });
    }
  }

  analyzeStrategies() {
    console.log('\n🎯 Strategy Performance');
    console.log('─'.repeat(70));

    if (!this.telemetry.strategies) {
      console.log('No strategy data available');
      return;
    }

    const strategies = Object.entries(this.telemetry.strategies)
      .filter(([_, stats]) => stats.attempts > 0)
      .map(([name, stats]) => ({
        name,
        attempts: stats.attempts,
        successes: stats.successes,
        successRate: (stats.successes / stats.attempts) * 100,
        avgTime: stats.avgTime / 1000
      }))
      .sort((a, b) => b.successRate - a.successRate);

    if (strategies.length === 0) {
      console.log('No strategies have been attempted yet');
      return;
    }

    // Display strategy table
    console.log('Strategy'.padEnd(20) + 'Success Rate'.padEnd(15) + 'Avg Time'.padEnd(12) + 'Attempts');
    console.log('─'.repeat(70));

    strategies.forEach(strategy => {
      const rateBar = this.createBar(strategy.successRate / 100, 10);
      console.log(
        strategy.name.padEnd(20) +
        `${rateBar} ${strategy.successRate.toFixed(1)}%`.padEnd(15) +
        `${strategy.avgTime.toFixed(1)}s`.padEnd(12) +
        strategy.attempts
      );
    });

    // Best strategy recommendation
    const best = strategies[0];
    if (best && best.attempts >= 3) {
      console.log(`\n🏆 Best Strategy: ${best.name} (${best.successRate.toFixed(1)}% success rate)`);

      this.recommendations.push({
        priority: 'INFO',
        message: `${best.name} is your most reliable strategy - consider making it the default`
      });
    }

    // Warn about failing strategies
    strategies
      .filter(s => s.successRate < 30 && s.attempts >= 5)
      .forEach(strategy => {
        this.recommendations.push({
          priority: 'MEDIUM',
          message: `${strategy.name} has poor performance (${strategy.successRate.toFixed(1)}%) - consider disabling`
        });
      });
  }

  analyzeErrors() {
    console.log('\n⚠️  Error Analysis');
    console.log('─'.repeat(70));

    if (!this.telemetry.builds) {
      console.log('No error data available');
      return;
    }

    const errors = this.telemetry.builds
      .filter(b => !b.success && b.error)
      .map(b => b.error);

    if (errors.length === 0) {
      console.log('No errors recorded');
      return;
    }

    // Group and count errors
    const errorTypes = {};
    const errorPatterns = [
      { pattern: /Resource busy/i, type: 'Resource Busy', solution: 'Clean up mounts and retry' },
      { pattern: /hdiutil.*failed/i, type: 'hdiutil Failure', solution: 'Use alternative strategy' },
      { pattern: /timeout/i, type: 'Timeout', solution: 'Increase timeout or use faster strategy' },
      { pattern: /permission denied/i, type: 'Permission', solution: 'Check file permissions' },
      { pattern: /not found/i, type: 'Missing File', solution: 'Verify build output paths' }
    ];

    errors.forEach(error => {
      let matched = false;
      for (const { pattern, type } of errorPatterns) {
        if (pattern.test(error)) {
          errorTypes[type] = (errorTypes[type] || 0) + 1;
          matched = true;
          break;
        }
      }
      if (!matched) {
        errorTypes['Other'] = (errorTypes['Other'] || 0) + 1;
      }
    });

    // Display error summary
    console.log('Error Type'.padEnd(25) + 'Count'.padEnd(10) + 'Solution');
    console.log('─'.repeat(70));

    Object.entries(errorTypes)
      .sort((a, b) => b[1] - a[1])
      .forEach(([type, count]) => {
        const solution = errorPatterns.find(p => p.type === type)?.solution || 'Check logs';
        console.log(type.padEnd(25) + count.toString().padEnd(10) + solution);
      });

    // Error-based recommendations
    if (errorTypes['Resource Busy'] > 3) {
      this.recommendations.push({
        priority: 'HIGH',
        message: 'Frequent "Resource busy" errors - implement better cleanup between attempts'
      });
    }

    if (errorTypes['hdiutil Failure'] > 5) {
      this.recommendations.push({
        priority: 'HIGH',
        message: 'hdiutil is unreliable - prioritize create-dmg or ZIP-only distribution'
      });
    }
  }

  generateRecommendations() {
    // Check current queue status
    if (this.status && Object.keys(this.status).length > 0) {
      const activeJobs = Object.values(this.status).filter(j =>
        j.status === 'building' || j.status === 'queued'
      );

      if (activeJobs.length > 0) {
        this.recommendations.push({
          priority: 'INFO',
          message: `${activeJobs.length} build job(s) currently active - monitor with: npm run dmg:monitor`
        });
      }
    }

    // Save recommendations
    if (this.recommendations.length > 0) {
      writeFileSync(RECOMMENDATIONS_FILE, JSON.stringify({
        timestamp: new Date().toISOString(),
        recommendations: this.recommendations
      }, null, 2));
    }
  }

  showRecommendations() {
    console.log('\n💡 Recommendations');
    console.log('─'.repeat(70));

    if (this.recommendations.length === 0) {
      console.log('✅ No issues detected - system is performing well!');
      return;
    }

    // Group by priority
    const high = this.recommendations.filter(r => r.priority === 'HIGH');
    const medium = this.recommendations.filter(r => r.priority === 'MEDIUM');
    const info = this.recommendations.filter(r => r.priority === 'INFO');

    if (high.length > 0) {
      console.log('\n🔴 HIGH Priority:');
      high.forEach(r => console.log(`  • ${r.message}`));
    }

    if (medium.length > 0) {
      console.log('\n🟡 MEDIUM Priority:');
      medium.forEach(r => console.log(`  • ${r.message}`));
    }

    if (info.length > 0) {
      console.log('\n🔵 INFO:');
      info.forEach(r => console.log(`  • ${r.message}`));
    }
  }

  createBar(percentage, width) {
    const filled = Math.round(percentage * width);
    const empty = width - filled;
    return '█'.repeat(filled) + '░'.repeat(empty);
  }

  showQuickActions() {
    console.log('\n🚀 Quick Actions');
    console.log('─'.repeat(70));
    console.log('npm run dmg:build      - Build DMG with best strategy');
    console.log('npm run dmg:async      - Queue DMG build in background');
    console.log('npm run dmg:monitor    - Real-time monitoring dashboard');
    console.log('npm run dmg:status     - Check build queue status');
    console.log('npm run package:mac:safe - Resilient build with fallbacks');
  }

  reset() {
    console.log('\n🔄 Reset Build Data');
    console.log('─'.repeat(70));

    const readline = require('readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    rl.question('Are you sure you want to reset all build telemetry? (y/N): ', (answer) => {
      if (answer.toLowerCase() === 'y') {
        try {
          writeFileSync(TELEMETRY_FILE, JSON.stringify({
            builds: [],
            strategies: {
              'create-dmg': { attempts: 0, successes: 0, avgTime: 0 },
              'hdiutil': { attempts: 0, successes: 0, avgTime: 0 },
              'appdmg': { attempts: 0, successes: 0, avgTime: 0 },
              'electron-builder': { attempts: 0, successes: 0, avgTime: 0 }
            }
          }, null, 2));

          writeFileSync(STATUS_FILE, '{}');

          console.log('✅ Build data reset successfully');
        } catch (error) {
          console.error('❌ Failed to reset:', error.message);
        }
      } else {
        console.log('Reset cancelled');
      }
      rl.close();
    });
  }
}

// Main execution
const args = process.argv.slice(2);

if (args.includes('--reset')) {
  new BuildDashboard().reset();
} else {
  const dashboard = new BuildDashboard();
  dashboard.analyze();
  dashboard.showQuickActions();

  console.log('\n' + '='.repeat(70));
  console.log('Run with --reset to clear all build history\n');
}