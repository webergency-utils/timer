import { defineConfig } from 'tsup';

export default defineConfig({
    entry     : [ 'src/timer.ts' ],
    format    : [ 'cjs', 'esm' ],
    dts       : true,
    sourcemap : false,
    minify    : false,
    clean     : true,
    shims     : true,
    splitting : false
});
