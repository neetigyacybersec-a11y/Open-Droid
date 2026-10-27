SHELL := /bin/bash
ROOT := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))
TOOLCHAIN := $(ROOT).toolchain
-include $(TOOLCHAIN)/env.sh

.PHONY: help setup doctor build-mcp test-mcp run-mcp new-app build-app emulator screenshot warm-cache register clean distclean

help:
	@echo "android-mcp product targets:"
	@echo "  setup        One-time download of full toolchain into .toolchain (offline afterwards)"
	@echo "  doctor       Verify toolchain + MCP build"
	@echo "  build-mcp    Build the MCP server (TypeScript)"
	@echo "  test-mcp     Run MCP server smoke tests"
	@echo "  run-mcp      Run the MCP server on stdio"
	@echo "  new-app      Scaffold a new Compose app from templates/compose-starter"
	@echo "  build-app    Build the app in APP_DIR (default ./my-app)"
	@echo "  warm-cache   Populate the Gradle cache (enables offline builds)"
	@echo "  register     Auto-register MCP + skills with OpenCode (global)"
	@echo "  emulator     Boot the default AVD"
	@echo "  screenshot   Capture a device screenshot to ./screenshots"
	@echo "  clean        Remove build artifacts"
	@echo "  distclean    Remove .toolchain and build artifacts (re-run setup afterwards)"

setup:
	bash scripts/setup.sh

doctor:
	bash scripts/doctor.sh

build-mcp:
	npm run build

test-mcp:
	npm test

run-mcp: build-mcp
	node dist/index.js

APP_DIR ?= my-app
new-app:
	@bash scripts/new-app.sh "$(APP_DIR)"

build-app:
	bash -c 'source .toolchain/env.sh && cd "$(APP_DIR)" && gradle :app:assembleDebug'

warm-cache:
	bash scripts/warm-cache.sh

register:
	bash scripts/register.sh

emulator:
	bash -c 'source .toolchain/env.sh && emulator -avd $${AVD_NAME:-Pixel_9_API_35} -no-snapshot-load'

screenshot:
	bash -c 'source .toolchain/env.sh && mkdir -p screenshots && adb shell screencap -p /sdcard/screen.png && adb pull /sdcard/screen.png screenshots/screen.png'
	@echo "saved screenshots/screen.png"

clean:
	rm -rf dist node_modules/.cache

distclean: clean
	rm -rf .toolchain
