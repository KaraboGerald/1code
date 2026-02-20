#!/usr/bin/env node

/**
 * Robust DMG builder for Apple Silicon (M1/M2/M3) processors
 * Handles intermittent hdiutil failures with retry logic and cleanup
 */

import { execSync, spawn } from 'child_process';
import { existsSync, readFileSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

const pkgJson = JSON.parse(
  readFileSync(join(projectRoot, 'package.json'), 'utf8')
);
const version = pkgJson.version || '0.0.0';
const productName = pkgJson.build?.productName || pkgJson.productName || '1Code';
const outputDir = pkgJson.build?.directories?.output || 'release';

function resolveAppPath() {
  const candidates = [
    join(projectRoot, outputDir, 'mac-arm64', `${productName}.app`),
    join(projectRoot, 'release', 'mac-arm64', `${productName}.app`),
    join(projectRoot, 'dist', 'mac-arm64', `${productName}.app`),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

// Configuration
const config = {
  appName: productName,
  volumeName: productName,
  appPath: resolveAppPath(),
  outputDir: join(projectRoot, outputDir),
  dmgPath: null, // Will be set later
  tempBasePath: null, // Will be set later
  maxRetries: 5,
  retryDelay: 3000, // 3 seconds
  cleanupDelay: 2000, // 2 seconds
  hdutilTimeout: 120000, // 2 minutes
};

// Set DMG paths
config.dmgPath = join(config.outputDir, `${productName}-${version}-arm64.dmg`);
config.tempBasePath = join(config.outputDir, `${productName}-${version}-temp`);

// Utility functions
function log(message, level = 'info') {
  const prefix = {
    info: '✓',
    warn: '⚠',
    error: '✗',
    debug: '→'
  }[level] || '•';

  console.log(`[${new Date().toISOString()}] ${prefix} ${message}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function execCommand(command, options = {}) {
  try {
    log(`Executing: ${command}`, 'debug');
    const result = execSync(command, {
      encoding: 'utf8',
      stdio: options.silent ? 'pipe' : 'inherit',
      ...options
    });
    return result;
  } catch (error) {
    if (!options.ignoreErrors) {
      throw error;
    }
    return null;
  }
}

async function execWithTimeout(command, timeoutMs = config.hdutilTimeout) {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', command], {
      stdio: 'inherit'
    });

    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Command timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on('exit', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command failed with code ${code}`));
      }
    });

    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

// Cleanup functions
async function cleanupMounts() {
  log('Cleaning up any existing mounts...', 'info');

  // Find all mounted volumes with our app name
  try {
    const mounts = execCommand('hdiutil info', { silent: true }) || '';
    const lines = mounts.split('\n');

    for (const line of lines) {
      if (line.includes(config.volumeName) || line.includes('/Volumes/' + config.volumeName)) {
        // Extract device from the mount info
        const deviceMatch = line.match(/\/dev\/disk\d+(s\d+)?/);
        if (deviceMatch) {
          const device = deviceMatch[0];
          log(`Unmounting ${device}...`, 'debug');
          execCommand(`hdiutil detach "${device}" -force`, { ignoreErrors: true });
          await sleep(1000);
        }
      }
    }
  } catch (error) {
    log('Could not check for existing mounts (non-critical)', 'debug');
  }

  // Also try unmounting by volume path
  const volumePath = `/Volumes/${config.volumeName}`;
  if (existsSync(volumePath)) {
    log(`Unmounting ${volumePath}...`, 'debug');
    execCommand(`hdiutil detach "${volumePath}" -force`, { ignoreErrors: true });
    await sleep(config.cleanupDelay);
  }
}

async function cleanupTempFiles() {
  log('Cleaning up temporary files...', 'info');

  // Remove temp DMG if exists
  if (existsSync(config.tempBasePath)) {
    rmSync(config.tempBasePath, { force: true, recursive: true });
  }
  if (existsSync(`${config.tempBasePath}.sparseimage`)) {
    rmSync(`${config.tempBasePath}.sparseimage`, { force: true, recursive: true });
  }

  // Remove existing final DMG if exists
  if (existsSync(config.dmgPath)) {
    rmSync(config.dmgPath, { force: true });
  }
}

// DMG creation functions
async function createDMG(attempt = 1) {
  log(`Creating DMG (attempt ${attempt}/${config.maxRetries})...`, 'info');

  try {
    // Step 1: Create a sparse image
    log('Creating sparse image...', 'debug');
    await execWithTimeout(`
      hdiutil create -size 500m \
        -fs HFS+ \
        -volname "${config.volumeName}" \
        -type SPARSE \
        -layout SPUD \
        "${config.tempBasePath}"
    `);

    // Step 2: Mount the sparse image
    log('Mounting sparse image...', 'debug');
    execCommand(`hdiutil attach "${config.tempBasePath}.sparseimage" -nobrowse -noverify -noautoopen`, { silent: true });

    // Extract mount point
    const mountPoint = `/Volumes/${config.volumeName}`;

    // Step 3: Copy app to mounted volume
    log('Copying application to disk image...', 'debug');
    execCommand(`cp -R "${config.appPath}" "${mountPoint}/"`);

    // Step 4: Create Applications symlink
    log('Creating Applications symlink...', 'debug');
    execCommand(`ln -s /Applications "${mountPoint}/Applications"`);

    // Step 5: Set custom icon positions (optional)
    log('Setting icon positions...', 'debug');
    const appleScript = `
      tell application "Finder"
        tell disk "${config.volumeName}"
          open
          set current view of container window to icon view
          set toolbar visible of container window to false
          set statusbar visible of container window to false
          set the bounds of container window to {400, 100, 940, 480}
          set theViewOptions to the icon view options of container window
          set arrangement of theViewOptions to not arranged
          set icon size of theViewOptions to 80
          set position of item "${config.appName}.app" of container window to {140, 150}
          set position of item "Applications" of container window to {400, 150}
          update without registering applications
          delay 2
          close
        end tell
      end tell
    `;

    try {
      execCommand(`osascript -e '${appleScript.replace(/'/g, "'\"'\"'")}'`, { ignoreErrors: true });
    } catch (error) {
      log('Could not set icon positions (non-critical)', 'warn');
    }

    // Step 6: Sync and wait
    log('Syncing filesystem...', 'debug');
    execCommand('sync');
    await sleep(2000);

    // Step 7: Detach the volume
    log('Detaching volume...', 'debug');
    let detached = false;
    for (let i = 0; i < 3; i++) {
      try {
        execCommand(`hdiutil detach "${mountPoint}" -force`);
        detached = true;
        break;
      } catch (error) {
        log(`Detach attempt ${i + 1} failed, retrying...`, 'warn');
        await sleep(2000);
      }
    }

    if (!detached) {
      throw new Error('Failed to detach volume after multiple attempts');
    }

    await sleep(1000);

    // Step 8: Convert to compressed DMG
    log('Converting to compressed DMG...', 'debug');
    await execWithTimeout(`
      hdiutil convert "${config.tempBasePath}.sparseimage" \
        -format UDZO \
        -imagekey zlib-level=9 \
        -o "${config.dmgPath}"
    `);

    // Step 9: Clean up sparse image
    log('Cleaning up sparse image...', 'debug');
    rmSync(`${config.tempBasePath}.sparseimage`, { force: true, recursive: true });

    // Step 10: Verify DMG
    log('Verifying DMG...', 'debug');
    execCommand(`hdiutil verify "${config.dmgPath}"`);

    log(`DMG created successfully: ${config.dmgPath}`, 'info');
    return true;

  } catch (error) {
    log(`DMG creation failed: ${error.message}`, 'error');

    // Cleanup on failure
    await cleanupMounts();

    // Clean up any partial files
    if (existsSync(`${config.tempBasePath}.sparseimage`)) {
      rmSync(`${config.tempBasePath}.sparseimage`, { force: true, recursive: true });
    }

    if (attempt < config.maxRetries) {
      log(`Retrying in ${config.retryDelay / 1000} seconds...`, 'info');
      await sleep(config.retryDelay);
      return createDMG(attempt + 1);
    }

    throw error;
  }
}

// Main function
async function main() {
  try {
    log('Starting DMG build process for Apple Silicon...', 'info');

    // Check if app exists
    if (!existsSync(config.appPath)) {
      throw new Error(`Application not found at: ${config.appPath}\nPlease run 'npm run build' and 'npm run package:mac' first.`);
    }

    // Initial cleanup
    await cleanupMounts();
    await cleanupTempFiles();

    // Create DMG with retry logic
    await createDMG();

    // Final verification
    const stats = execCommand(`stat -f "%z" "${config.dmgPath}"`, { silent: true });
    const sizeMB = Math.round(parseInt(stats) / 1024 / 1024);
    log(`✅ DMG created successfully: ${config.dmgPath} (${sizeMB} MB)`, 'info');

  } catch (error) {
    log(`❌ DMG build failed: ${error.message}`, 'error');
    process.exit(1);
  }
}

// Handle process termination
process.on('SIGINT', async () => {
  log('Interrupted, cleaning up...', 'warn');
  await cleanupMounts();
  process.exit(130);
});

process.on('SIGTERM', async () => {
  log('Terminated, cleaning up...', 'warn');
  await cleanupMounts();
  process.exit(143);
});

// Run main function
main().catch(error => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
