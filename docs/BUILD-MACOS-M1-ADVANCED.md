# macOS Apple Silicon Build Guide - Advanced Edition

## 🚀 Overview

The advanced build system for 1Code on Apple Silicon (M1/M2/M3) now includes:

- **Multiple DMG creation strategies** with automatic fallback
- **Machine learning-based strategy selection** using build telemetry
- **Background queue processing** for non-blocking builds
- **Real-time monitoring dashboard** with live updates
- **Comprehensive build analytics** and recommendations

## 📊 New Features

### 1. Advanced DMG Builder

The `dmg-builder-advanced.mjs` script provides:

- **4 Different Strategies**:
  - `create-dmg`: Modern, reliable DMG creator (recommended)
  - `hdiutil`: Native macOS tool (prone to failures on M-series)
  - `appdmg`: Node-based DMG creator
  - `electron-builder`: Fallback to electron-builder's DMG

- **Automatic Strategy Selection**: Based on historical success rates
- **Telemetry Tracking**: Records success/failure for each strategy
- **Smart Retries**: Tries different strategies on failure

### 2. Background Queue System

Build DMGs without blocking your workflow:

```bash
# Queue a DMG build in the background
npm run dmg:async

# Check queue status
npm run dmg:status

# Monitor in real-time
npm run dmg:monitor
```

### 3. Build Dashboard

Comprehensive analytics and insights:

```bash
# View build dashboard
npm run dmg:dashboard
```

Shows:
- System compatibility check
- Build success rates and trends
- Strategy performance comparison
- Error analysis with solutions
- Personalized recommendations

### 4. Real-time Monitor

Live monitoring with interactive controls:

```bash
npm run dmg:monitor
```

Features:
- Live queue status
- Strategy performance metrics
- Recent build history
- Interactive controls (pause, clear, telemetry view)

## 📦 Installation

Install the additional dependencies:

```bash
npm install
# or
bun install
```

The system will automatically install:
- `create-dmg`: Modern DMG creation tool
- `p-queue`: Queue management for background builds

Optional tools (install globally for better performance):
```bash
npm install -g create-dmg
npm install -g appdmg  # Optional alternative
```

## 🎯 Usage Guide

### Quick Start

For most users, the simplest approach:

```bash
# Resilient build with all strategies
npm run package:mac:safe

# Or use the advanced builder directly
npm run dmg:build
```

### Advanced Usage

#### Strategy-Specific Builds

```bash
# Force a specific strategy
node scripts/dmg-builder-advanced.mjs --strategy=create-dmg

# Use app from specific location
node scripts/dmg-builder-advanced.mjs --app=release/mac-arm64/1Code.app

# Custom output path
node scripts/dmg-builder-advanced.mjs --output=release/custom.dmg
```

#### Background Processing

Perfect for CI/CD or when you need to continue working:

```bash
# Queue build and get job ID
npm run dmg:async
# Output: DMG build queued with job ID: 1234567890

# Check specific job
node scripts/dmg-builder-advanced.mjs --status=1234567890

# Check all jobs
npm run dmg:status
```

#### Monitoring & Analytics

```bash
# Real-time monitor (interactive)
npm run dmg:monitor

# Dashboard with recommendations
npm run dmg:dashboard

# Reset all telemetry data
npm run dmg:reset
```

## 📈 Build Telemetry

The system tracks build performance to optimize future builds:

### Data Collected
- Strategy used
- Success/failure
- Build duration
- Error messages
- Platform information

### Data Location
- Telemetry: `.build-telemetry.json`
- Queue status: `.dmg-build-status.json`
- Recommendations: `.build-recommendations.json`

### Privacy
All data is stored locally and never transmitted.

## 🔧 Troubleshooting

### Strategy-Specific Issues

#### create-dmg fails
```bash
# Install/update create-dmg
npm install -g create-dmg

# Or use npx (slower but always works)
# The script automatically falls back to npx
```

#### hdiutil hangs
```bash
# Kill hanging processes
pkill -f hdiutil

# Clear mounts
hdiutil detach /Volumes/1Code -force

# Use different strategy
node scripts/dmg-builder-advanced.mjs --strategy=create-dmg
```

#### Background build stuck
```bash
# Check status
npm run dmg:status

# Clear completed jobs
# In monitor, press 'c'

# Or manually clear
rm .dmg-build-status.json
```

### Performance Optimization

1. **Check Dashboard First**:
   ```bash
   npm run dmg:dashboard
   ```
   Follow personalized recommendations

2. **Use Best Strategy**:
   The system automatically selects the best strategy based on your history

3. **Background Builds for Large Projects**:
   ```bash
   npm run dmg:async
   ```

4. **Monitor Resource Usage**:
   ```bash
   # In another terminal
   npm run dmg:monitor
   ```

## 📊 Interpreting Analytics

### Success Rate Trends
- **📈 Improving**: System is learning and optimizing
- **📉 Declining**: May need cleanup or system restart
- **→ Stable**: Consistent performance

### Strategy Performance
- **80%+ success**: Excellent, make it default
- **50-80% success**: Acceptable, use as fallback
- **<50% success**: Poor, consider disabling

### Error Patterns
- **Resource Busy**: Clean up mounts between builds
- **Timeout**: Increase timeout or use faster strategy
- **Permission**: Check file permissions

## 🎮 Interactive Monitor Controls

When running `npm run dmg:monitor`:

- `q` - Quit
- `r` - Refresh display
- `c` - Clear completed jobs
- `t` - Show detailed telemetry
- `p` - Pause/resume auto-refresh

## 🔄 CI/CD Integration

### GitHub Actions Example

```yaml
- name: Build DMG
  run: |
    npm install
    npm run dmg:build
  continue-on-error: true

- name: Fallback to ZIP
  if: failure()
  run: |
    npm run build
    electron-builder --mac zip --arm64
```

### Jenkins Example

```groovy
stage('Build DMG') {
    steps {
        sh 'npm run dmg:async'
        sh 'sleep 5'

        script {
            def maxAttempts = 60
            def attempt = 0
            def jobId = sh(
                script: 'npm run dmg:status | grep "Job" | head -1 | cut -d: -f2',
                returnStdout: true
            ).trim()

            while (attempt < maxAttempts) {
                def status = sh(
                    script: "node scripts/dmg-builder-advanced.mjs --status=${jobId} | jq -r '.status'",
                    returnStdout: true
                ).trim()

                if (status == 'completed') {
                    echo "DMG build completed"
                    break
                } else if (status == 'failed') {
                    error "DMG build failed"
                }

                sleep(time: 2, unit: 'SECONDS')
                attempt++
            }
        }
    }
}
```

## 🏆 Best Practices

1. **Regular Monitoring**: Check dashboard weekly
2. **Clean Telemetry**: Reset quarterly or after major changes
3. **Update Dependencies**: Keep create-dmg and electron-builder current
4. **Use Background Builds**: For non-critical builds
5. **Monitor Success Rates**: Switch strategies if <50% success

## 📝 Configuration

### Environment Variables

```bash
# Force specific strategy
export DMG_STRATEGY=create-dmg

# Increase timeout (ms)
export DMG_TIMEOUT=180000

# Disable telemetry
export DMG_NO_TELEMETRY=1
```

### Custom Configuration

Edit `scripts/dmg-builder-advanced.mjs`:

```javascript
const config = {
  maxRetries: 5,        // Increase retries
  timeout: 180000,      // 3 minutes
  format: 'UDZO',       // Compression format
  internetEnabled: true // Internet-enabled DMGs
};
```

## 🔍 Debugging

Enable verbose output:

```bash
# Debug mode
DEBUG=* npm run dmg:build

# Specific debug
DEBUG=dmg:* npm run dmg:build
```

Check logs:
```bash
# Build log
cat build.log

# Telemetry
cat .build-telemetry.json | jq

# Queue status
cat .dmg-build-status.json | jq
```

## 📚 Additional Resources

- [create-dmg Documentation](https://github.com/sindresorhus/create-dmg)
- [electron-builder DMG Options](https://www.electron.build/mac)
- [Apple Developer - Disk Images](https://developer.apple.com/documentation/)

## 🤝 Contributing

To improve the build system:

1. Run builds and let telemetry collect data
2. Report issues with telemetry data attached
3. Test new strategies and submit PRs

---

**Version**: 2.0.0
**Last Updated**: February 2025
**Compatibility**: macOS 13+, Apple Silicon (M1/M2/M3)