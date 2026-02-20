# macOS Apple Silicon (M1/M2/M3) Build Guide

## Overview

This document describes the resilient build system for creating DMG installers on Apple Silicon Macs. The system is designed to handle intermittent `hdiutil` failures that commonly occur on M-series processors.

## Problem Statement

The standard electron-builder DMG creation process frequently fails on Apple Silicon due to:
- `hdiutil` resource busy errors
- Device not configured errors
- Volume mount/unmount timing issues
- File system sync delays specific to M processors

## Solution Architecture

We've implemented a multi-layered resilient build system with:

1. **Custom DMG builder** with retry logic
2. **Enhanced electron-builder config** optimized for M processors
3. **Fallback strategies** for when DMG creation fails
4. **Comprehensive error recovery**

## Available Build Commands

### Standard Commands

```bash
# Standard build (may fail intermittently)
npm run package:mac

# M1-optimized build with enhanced config
npm run package:mac:m1

# Build with manual DMG creation fallback
npm run package:mac:dmg

# Safe build (ZIP first, then DMG)
npm run package:mac:safe
```

### Resilient Build Script

For maximum reliability, use the comprehensive build script:

```bash
./scripts/build-mac-resilient.sh
```

This script:
- Attempts multiple build strategies
- Automatically retries on failure
- Cleans up hanging resources
- Falls back to ZIP if DMG fails
- Provides detailed logging

## Build Strategies

### Strategy 1: Standard Build
```bash
npm run package:mac
```
- Uses default electron-builder DMG creation
- Fast but prone to intermittent failures

### Strategy 2: M1-Optimized Config
```bash
npm run package:mac:m1
```
- Uses `electron-builder-m1.yml` configuration
- Optimized compression and DMG settings
- Internet-enabled DMGs for better reliability

### Strategy 3: Manual DMG Creation
```bash
node scripts/build-dmg-m1.mjs
```
- Custom DMG builder with extensive retry logic
- Handles volume mounting/unmounting carefully
- Includes cleanup and verification steps
- Can be run independently after ZIP creation

### Strategy 4: ZIP Fallback
```bash
electron-builder --mac --arm64 --mac.target zip
```
- Creates only ZIP archive (always works)
- DMG can be created later manually
- Useful for CI/CD environments

## File Structure

```
1code/
├── scripts/
│   ├── build-dmg-m1.mjs          # Custom DMG builder
│   ├── build-mac-resilient.sh    # Main resilient build script
│   └── after-pack.mjs            # Post-processing hook
├── electron-builder.yml          # Base configuration
├── electron-builder-m1.yml       # M1-optimized config
└── package.json                  # Build commands
```

## Troubleshooting

### DMG Creation Fails

1. **Check for mounted volumes:**
   ```bash
   hdiutil info
   # Look for any 1Code volumes
   ```

2. **Force unmount if needed:**
   ```bash
   hdiutil detach /Volumes/1Code -force
   ```

3. **Clear electron-builder cache:**
   ```bash
   rm -rf ~/Library/Caches/electron-builder
   ```

4. **Kill hanging processes:**
   ```bash
   pkill -f hdiutil
   ```

### Resource Busy Errors

The scripts automatically handle these, but if manual intervention is needed:

```bash
# Find and kill processes using the volume
lsof | grep "/Volumes/1Code"
# Kill the process IDs found

# Or use the cleanup function
node -e "
  const { execSync } = require('child_process');
  execSync('hdiutil detach /Volumes/1Code -force', { stdio: 'inherit' });
"
```

### Verification Failed

If DMG verification fails but the file exists:
1. The DMG is likely still usable
2. Test by manually mounting:
   ```bash
   hdiutil attach release/1Code-arm64.dmg
   ```
3. If it mounts, the DMG is fine

## Environment Variables

For code signing and notarization (optional):

```bash
export APPLE_IDENTITY="Developer ID Application: Your Name (TEAM_ID)"
export APPLE_TEAM_ID="TEAM_ID"
```

## CI/CD Integration

For automated builds, use the resilient script:

```yaml
# Example GitHub Actions
- name: Build macOS App
  run: |
    npm install
    ./scripts/build-mac-resilient.sh
```

Or use the safe mode for CI:

```yaml
- name: Build macOS App (Safe Mode)
  run: |
    npm install
    npm run package:mac:safe
```

## Performance Tips

1. **Close other applications** - Reduces resource contention
2. **Ensure adequate disk space** - Need ~2GB free
3. **Run on native Apple Silicon** - Not Rosetta
4. **Disable Spotlight indexing** during build:
   ```bash
   sudo mdutil -i off /Volumes/1Code
   ```

## Recovery Process

If all automated attempts fail:

1. **Create ZIP only:**
   ```bash
   npm run build
   electron-builder --mac --arm64 --mac.target zip
   ```

2. **Manually create DMG later:**
   ```bash
   # After system is less busy
   node scripts/build-dmg-m1.mjs
   ```

3. **Distribute ZIP if urgent:**
   - ZIP files work fine for distribution
   - Users can drag app to Applications manually

## Logs and Debugging

Build logs are saved to:
- `build.log` - Main build output
- Console output includes timestamps and status

Enable verbose logging:
```bash
DEBUG=electron-builder npm run package:mac
```

## Known Issues

1. **First build after reboot** - May fail, retry usually works
2. **Multiple simultaneous builds** - Will conflict, run sequentially
3. **Spotlight indexing** - Can interfere, disable temporarily
4. **Time Machine backups** - Can cause resource busy errors

## Support

For persistent issues:
1. Check the build logs
2. Try the resilient build script
3. Fall back to ZIP distribution
4. Report issues with full logs

## Version Compatibility

Tested with:
- macOS 13+ (Ventura and later)
- Apple M1, M2, M3 processors
- electron-builder 25.x
- Node.js 18+

---

Last updated: February 2025