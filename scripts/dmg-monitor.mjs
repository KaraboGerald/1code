#!/usr/bin/env node

/**
 * DMG Build Monitor
 * Real-time monitoring of DMG build queue and telemetry
 */

import { existsSync, readFileSync, watchFile } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

const STATUS_FILE = join(projectRoot, '.dmg-build-status.json');
const TELEMETRY_FILE = join(projectRoot, '.build-telemetry.json');

// ANSI color codes
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m'
};

class DMGMonitor {
  constructor() {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    this.statusData = {};
    this.telemetryData = {};
    this.refreshInterval = null;
    this.autoRefresh = true;
  }

  async start() {
    console.clear();
    console.log(`${colors.cyan}${colors.bright}📊 DMG Build Monitor${colors.reset}\n`);

    // Load initial data
    this.loadStatus();
    this.loadTelemetry();

    // Set up file watchers
    if (existsSync(STATUS_FILE)) {
      watchFile(STATUS_FILE, { interval: 1000 }, () => {
        this.loadStatus();
        if (this.autoRefresh) this.render();
      });
    }

    if (existsSync(TELEMETRY_FILE)) {
      watchFile(TELEMETRY_FILE, { interval: 1000 }, () => {
        this.loadTelemetry();
        if (this.autoRefresh) this.render();
      });
    }

    // Initial render
    this.render();

    // Set up auto-refresh
    this.refreshInterval = setInterval(() => {
      if (this.autoRefresh) this.render();
    }, 2000);

    // Handle user input
    this.setupInputHandlers();
  }

  loadStatus() {
    try {
      if (existsSync(STATUS_FILE)) {
        this.statusData = JSON.parse(readFileSync(STATUS_FILE, 'utf8'));
      }
    } catch (error) {
      console.error('Failed to load status:', error.message);
    }
  }

  loadTelemetry() {
    try {
      if (existsSync(TELEMETRY_FILE)) {
        this.telemetryData = JSON.parse(readFileSync(TELEMETRY_FILE, 'utf8'));
      }
    } catch (error) {
      console.error('Failed to load telemetry:', error.message);
    }
  }

  render() {
    // Save cursor position
    process.stdout.write('\x1b7');

    // Clear screen and reset cursor
    process.stdout.write('\x1b[2J\x1b[H');

    // Header
    console.log(`${colors.cyan}${colors.bright}📊 DMG Build Monitor${colors.reset}`);
    console.log(`${colors.dim}Press 'q' to quit, 'r' to refresh, 'c' to clear completed, 't' for telemetry${colors.reset}\n`);

    // Current time
    console.log(`${colors.dim}Last updated: ${new Date().toLocaleTimeString()}${colors.reset}\n`);

    // Build Queue Status
    this.renderQueueStatus();

    // Telemetry Summary
    this.renderTelemetrySummary();

    // Recent Builds
    this.renderRecentBuilds();

    // Restore cursor position
    process.stdout.write('\x1b8');
  }

  renderQueueStatus() {
    console.log(`${colors.bright}🔧 Build Queue${colors.reset}`);
    console.log('─'.repeat(60));

    const jobs = Object.entries(this.statusData);

    if (jobs.length === 0) {
      console.log(`${colors.dim}No build jobs in queue${colors.reset}`);
    } else {
      // Group by status
      const queued = jobs.filter(([_, job]) => job.status === 'queued');
      const building = jobs.filter(([_, job]) => job.status === 'building');
      const completed = jobs.filter(([_, job]) => job.status === 'completed');
      const failed = jobs.filter(([_, job]) => job.status === 'failed');

      // Show active jobs first
      [...building, ...queued].forEach(([id, job]) => {
        const statusIcon = job.status === 'building' ? '🔨' : '⏳';
        const statusColor = job.status === 'building' ? colors.yellow : colors.blue;

        console.log(`${statusIcon} ${statusColor}[${job.status.toUpperCase()}]${colors.reset} Job ${id}`);
        console.log(`  └─ ${job.config.volumeName} → ${job.config.outputPath.split('/').pop()}`);
        console.log(`     Started: ${new Date(job.timestamp).toLocaleTimeString()}`);
      });

      // Show recent completed
      completed.slice(-3).forEach(([id, job]) => {
        console.log(`✅ ${colors.green}[COMPLETED]${colors.reset} Job ${id}`);
        console.log(`  └─ ${job.config.outputPath.split('/').pop()}`);
      });

      // Show recent failed
      failed.slice(-2).forEach(([id, job]) => {
        console.log(`❌ ${colors.red}[FAILED]${colors.reset} Job ${id}`);
        if (job.error) {
          console.log(`  └─ Error: ${job.error}`);
        }
      });

      // Summary
      console.log(`\n${colors.dim}Total: ${jobs.length} | Building: ${building.length} | Queued: ${queued.length} | Done: ${completed.length} | Failed: ${failed.length}${colors.reset}`);
    }

    console.log();
  }

  renderTelemetrySummary() {
    console.log(`${colors.bright}📈 Strategy Performance${colors.reset}`);
    console.log('─'.repeat(60));

    if (!this.telemetryData.strategies) {
      console.log(`${colors.dim}No telemetry data available${colors.reset}`);
    } else {
      const strategies = Object.entries(this.telemetryData.strategies)
        .filter(([_, stats]) => stats.attempts > 0)
        .sort((a, b) => {
          const aRate = a[1].successes / a[1].attempts;
          const bRate = b[1].successes / b[1].attempts;
          return bRate - aRate;
        });

      strategies.forEach(([name, stats]) => {
        const successRate = ((stats.successes / stats.attempts) * 100).toFixed(1);
        const bar = this.createProgressBar(successRate / 100, 20);
        const rateColor = successRate >= 80 ? colors.green :
                         successRate >= 50 ? colors.yellow : colors.red;

        console.log(`${name.padEnd(20)} ${bar} ${rateColor}${successRate}%${colors.reset}`);
        console.log(`${colors.dim}  └─ ${stats.successes}/${stats.attempts} successful, ~${(stats.avgTime / 1000).toFixed(1)}s avg${colors.reset}`);
      });
    }

    console.log();
  }

  renderRecentBuilds() {
    console.log(`${colors.bright}📜 Recent Builds${colors.reset}`);
    console.log('─'.repeat(60));

    if (!this.telemetryData.builds || this.telemetryData.builds.length === 0) {
      console.log(`${colors.dim}No recent builds${colors.reset}`);
    } else {
      const recentBuilds = this.telemetryData.builds.slice(-5).reverse();

      recentBuilds.forEach(build => {
        const icon = build.success ? '✅' : '❌';
        const timeAgo = this.getTimeAgo(new Date(build.timestamp));
        const duration = (build.duration / 1000).toFixed(1);

        console.log(`${icon} ${build.strategy.padEnd(20)} ${colors.dim}${duration}s • ${timeAgo}${colors.reset}`);
        if (!build.success && build.error) {
          console.log(`  ${colors.red}└─ ${build.error.substring(0, 50)}${colors.reset}`);
        }
      });
    }

    console.log();
  }

  createProgressBar(percentage, width) {
    const filled = Math.round(percentage * width);
    const empty = width - filled;
    const bar = '█'.repeat(filled) + '░'.repeat(empty);
    return `[${bar}]`;
  }

  getTimeAgo(date) {
    const seconds = Math.floor((new Date() - date) / 1000);

    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  }

  setupInputHandlers() {
    // Set raw mode to capture single keystrokes
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    process.stdin.on('data', (key) => {
      switch (key) {
        case 'q':
        case '\u0003': // Ctrl+C
          this.cleanup();
          break;
        case 'r':
          this.loadStatus();
          this.loadTelemetry();
          this.render();
          break;
        case 'c':
          this.clearCompleted();
          break;
        case 't':
          this.showDetailedTelemetry();
          break;
        case 'p':
          this.autoRefresh = !this.autoRefresh;
          console.log(`\n${colors.yellow}Auto-refresh ${this.autoRefresh ? 'enabled' : 'paused'}${colors.reset}`);
          break;
      }
    });
  }

  clearCompleted() {
    const jobs = Object.entries(this.statusData);
    const active = jobs.filter(([_, job]) =>
      job.status === 'queued' || job.status === 'building'
    );

    this.statusData = Object.fromEntries(active);

    // Save updated status
    writeFileSync(STATUS_FILE, JSON.stringify(this.statusData, null, 2));

    console.log(`\n${colors.green}Cleared completed jobs${colors.reset}`);
    setTimeout(() => this.render(), 1000);
  }

  showDetailedTelemetry() {
    console.clear();
    console.log(`${colors.cyan}${colors.bright}📊 Detailed Telemetry Report${colors.reset}\n`);

    if (!this.telemetryData.builds) {
      console.log('No telemetry data available');
      console.log('\nPress any key to return...');
      return;
    }

    // Overall stats
    const totalBuilds = this.telemetryData.builds.length;
    const successfulBuilds = this.telemetryData.builds.filter(b => b.success).length;
    const overallSuccessRate = totalBuilds > 0 ?
      ((successfulBuilds / totalBuilds) * 100).toFixed(1) : 0;

    console.log(`${colors.bright}Overall Statistics${colors.reset}`);
    console.log(`├─ Total builds: ${totalBuilds}`);
    console.log(`├─ Successful: ${successfulBuilds}`);
    console.log(`├─ Failed: ${totalBuilds - successfulBuilds}`);
    console.log(`└─ Success rate: ${overallSuccessRate}%\n`);

    // Per-strategy breakdown
    console.log(`${colors.bright}Strategy Breakdown${colors.reset}`);
    Object.entries(this.telemetryData.strategies).forEach(([name, stats]) => {
      if (stats.attempts > 0) {
        const successRate = ((stats.successes / stats.attempts) * 100).toFixed(1);
        console.log(`\n${name}:`);
        console.log(`├─ Attempts: ${stats.attempts}`);
        console.log(`├─ Successes: ${stats.successes}`);
        console.log(`├─ Success rate: ${successRate}%`);
        console.log(`└─ Average time: ${(stats.avgTime / 1000).toFixed(1)}s`);
      }
    });

    // Error analysis
    const errors = this.telemetryData.builds
      .filter(b => !b.success && b.error)
      .map(b => b.error);

    if (errors.length > 0) {
      console.log(`\n${colors.bright}Common Errors${colors.reset}`);
      const errorCounts = {};
      errors.forEach(error => {
        const key = error.substring(0, 50);
        errorCounts[key] = (errorCounts[key] || 0) + 1;
      });

      Object.entries(errorCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .forEach(([error, count]) => {
          console.log(`├─ ${error}... (${count}x)`);
        });
    }

    console.log('\n\nPress any key to return...');
  }

  cleanup() {
    // Clear watchers
    if (existsSync(STATUS_FILE)) {
      watchFile(STATUS_FILE, () => {});
    }
    if (existsSync(TELEMETRY_FILE)) {
      watchFile(TELEMETRY_FILE, () => {});
    }

    // Clear interval
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
    }

    // Reset terminal
    process.stdout.write('\x1b[?25h'); // Show cursor
    console.clear();

    this.rl.close();
    process.exit(0);
  }
}

// Main execution
const monitor = new DMGMonitor();
monitor.start().catch(error => {
  console.error('Monitor error:', error);
  process.exit(1);
});