/**
 * Test stand-in for the `server-only` package.
 *
 * `server-only` deliberately throws unless it is resolved under a bundler condition that
 * only Next.js provides, which would make every module carrying the guard impossible to
 * unit test. Aliasing it to this empty module in the Vitest config keeps the guard active in
 * real builds — where it does its job of failing the build if server code is pulled into a
 * client bundle — while letting the same modules be exercised directly in tests.
 */
export {};
