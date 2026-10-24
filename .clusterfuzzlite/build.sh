#!/bin/bash -eu

npm ci
npm run build

compile_javascript_fuzzer timer fuzz_timer.cjs
