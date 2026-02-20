#!/bin/bash

# Resilient macOS build script for Apple Silicon
# Handles intermittent DMG creation failures with multiple fallback strategies

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RELEASE_DIR="${PROJECT_ROOT}/release"
APP_NAME="1Code"
MAX_RETRIES=3
VERSION="$(node -e "process.stdout.write(require('${PROJECT_ROOT}/package.json').version)")"
DMG_NAME="${APP_NAME}-${VERSION}-arm64.dmg"
ZIP_NAME="${APP_NAME}-${VERSION}-arm64-mac.zip"

# Logging functions
log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warning() { echo -e "${YELLOW}[WARNING]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Cleanup function
cleanup() {
    log_info "Cleaning up..."

    # Unmount any hanging volumes
    if mount | grep -q "/Volumes/${APP_NAME}"; then
        log_info "Unmounting ${APP_NAME} volume..."
        hdiutil detach "/Volumes/${APP_NAME}" -force 2>/dev/null || true
    fi

    # Kill any hanging hdiutil processes
    pkill -f hdiutil 2>/dev/null || true

    # Clean up temp files
    rm -f ${RELEASE_DIR}/*.dmg.tmp 2>/dev/null || true
    rm -f ${RELEASE_DIR}/*.sparseimage 2>/dev/null || true
}

# Trap to ensure cleanup on exit
trap cleanup EXIT

# Check prerequisites
check_prerequisites() {
    log_info "Checking prerequisites..."

    # Check if running on Apple Silicon
    if [[ "$(uname -m)" != "arm64" ]]; then
        log_warning "Not running on Apple Silicon, but continuing..."
    fi

    # Check for node
    command -v node >/dev/null 2>&1 || {
      log_error "Node.js not found."
      exit 1
    }
    [ -x "${PROJECT_ROOT}/node_modules/.bin/electron-builder" ] || {
      log_error "electron-builder not found in node_modules. Please run 'npm install' first."
      exit 1
    }

    log_success "Prerequisites check passed"
}

# Build the application
build_app() {
    log_info "Building application..."

    cd "${PROJECT_ROOT}"

    # Clean previous builds
    rm -rf "${RELEASE_DIR}"

    # Run the build
    npm run build

    log_success "Application built successfully"
}

# Package with electron-builder
package_app() {
    local attempt=1
    local success=false

    while [ $attempt -le $MAX_RETRIES ] && [ "$success" = false ]; do
        log_info "Packaging application (attempt $attempt/$MAX_RETRIES)..."

        # Clean any previous attempt
        cleanup

        # Try different strategies based on attempt number
        case $attempt in
            1)
                # First attempt: Build zip only, then manual DMG (most reliable)
                log_info "Attempting zip build + manual DMG..."
                if npm run package:mac:dmg 2>&1 | tee build.log; then
                    if [ -f "${RELEASE_DIR}/${DMG_NAME}" ] || [ -f "${RELEASE_DIR}/${ZIP_NAME}" ]; then
                        success=true
                        log_success "Safe build succeeded"
                    fi
                fi
                ;;
            2)
                # Second attempt: retry zip + manual DMG after cleanup
                log_info "Retrying zip build + manual DMG after cleanup..."
                if npm run package:mac:dmg 2>&1 | tee build.log; then
                    if [ -f "${RELEASE_DIR}/${DMG_NAME}" ] || [ -f "${RELEASE_DIR}/${ZIP_NAME}" ]; then
                        success=true
                        log_success "Second attempt succeeded"
                    fi
                fi
                ;;
            3)
                # Third attempt: Use advanced DMG builder with multiple strategies
                log_info "Attempting with advanced DMG builder (multiple strategies)..."
                if npm run codex:prepare-acp && npx electron-builder --mac zip --arm64 2>&1 | tee build.log; then
                    # Try the advanced builder with automatic strategy selection
                    if node scripts/dmg-builder-advanced.mjs 2>&1 | tee -a build.log; then
                        success=true
                        log_success "Advanced DMG builder succeeded"
                    else
                        # At least we have a ZIP
                        if [ -f "${RELEASE_DIR}/${ZIP_NAME}" ]; then
                            log_warning "DMG failed but ZIP created successfully"
                            success=true
                        fi
                    fi
                fi
                ;;
        esac

        if [ "$success" = false ]; then
            log_warning "Attempt $attempt failed"

            # Check for specific errors in build log
            if grep -q "Resource busy" build.log; then
                log_info "Detected 'Resource busy' error, cleaning up mounts..."
                cleanup
                sleep 5
            elif grep -q "hdiutil: create failed" build.log; then
                log_info "Detected hdiutil failure, clearing cache..."
                rm -rf ~/Library/Caches/electron-builder
                sleep 3
            fi

            attempt=$((attempt + 1))
        fi
    done

    if [ "$success" = false ]; then
        log_error "All packaging attempts failed"

        # Final fallback: Create only ZIP
        log_info "Creating ZIP archive as final fallback..."
        rm -f "${RELEASE_DIR}/${ZIP_NAME}" 2>/dev/null || true
        ditto -c -k --sequesterRsrc --keepParent "${RELEASE_DIR}/mac-arm64/${APP_NAME}.app" "${RELEASE_DIR}/${ZIP_NAME}"

        if [ -f "${RELEASE_DIR}/${ZIP_NAME}" ]; then
            log_warning "Created ZIP archive instead of DMG"
            log_warning "DMG can be created manually later using: node scripts/build-dmg-m1.mjs"
        else
            log_error "Failed to create any distributable package"
            exit 1
        fi
    fi
}

# Verify build artifacts
verify_artifacts() {
    log_info "Verifying build artifacts..."

    local found_dmg=false
    local found_zip=false

    if [ -f "${RELEASE_DIR}/${DMG_NAME}" ]; then
        local size=$(du -h "${RELEASE_DIR}/${DMG_NAME}" | cut -f1)
        log_success "Found DMG: ${DMG_NAME} (${size})"
        found_dmg=true

        # Verify DMG
        if hdiutil verify "${RELEASE_DIR}/${DMG_NAME}" 2>/dev/null; then
            log_success "DMG verification passed"
        else
            log_warning "DMG verification failed, but file exists"
        fi
    fi

    if [ -f "${RELEASE_DIR}/${ZIP_NAME}" ]; then
        local size=$(du -h "${RELEASE_DIR}/${ZIP_NAME}" | cut -f1)
        log_success "Found ZIP: ${ZIP_NAME} (${size})"
        found_zip=true
    fi

    if [ "$found_dmg" = false ] && [ "$found_zip" = false ]; then
        log_error "No distributable artifacts found"
        exit 1
    fi
}

# Main execution
main() {
    log_info "Starting resilient macOS build for Apple Silicon"

    check_prerequisites
    build_app
    package_app
    verify_artifacts

    log_success "Build completed successfully!"
    log_info "Artifacts are in: ${RELEASE_DIR}"
}

# Run main function
main
