#!/usr/bin/env node

/**
 * After-pack hook for electron-builder
 * Handles post-processing and fallback operations for Apple Silicon builds
 */

import { existsSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';

export default async function afterPack(context) {
  const { appOutDir, packager, electronPlatformName, arch } = context;

  // Only run for macOS ARM64 builds
  if (electronPlatformName !== 'darwin' || arch !== 'arm64') {
    return;
  }

  console.log('Running after-pack hook for Apple Silicon...');

  try {
    // Check if we're in a DMG build context
    const isDmgBuild = packager.config.mac?.target?.some(t =>
      t.target === 'dmg' || (typeof t === 'string' && t === 'dmg')
    );

    if (isDmgBuild) {
      console.log('DMG build detected, preparing fallback mechanism...');

      // Store build information for potential fallback
      const buildInfo = {
        appOutDir,
        arch,
        productName: packager.config.productName,
        version: packager.config.version,
        timestamp: new Date().toISOString()
      };

      // Write build info for fallback script
      const buildInfoPath = join(appOutDir, '..', 'build-info.json');
      writeFileSync(buildInfoPath, JSON.stringify(buildInfo, null, 2));

      console.log('Build info saved for potential DMG fallback');
    }

    // Additional Apple Silicon optimizations
    if (process.platform === 'darwin' && process.arch === 'arm64') {
      // Clear extended attributes that might cause issues
      try {
        const appPath = join(appOutDir, `${packager.config.productName}.app`);
        if (existsSync(appPath)) {
          console.log('Clearing extended attributes...');
          execSync(`xattr -cr "${appPath}"`, { stdio: 'inherit' });
        }
      } catch (error) {
        console.warn('Could not clear extended attributes:', error.message);
      }
    }

  } catch (error) {
    console.error('After-pack hook error:', error);
    // Don't fail the build on after-pack errors
  }
}
