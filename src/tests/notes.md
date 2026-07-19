# Testing Notes

## Rules
- Tests must be executed using Vitest.
- Always isolate tests using beforeEach/afterEach and avoid shared states across tests.
- When verifying date/time logic, use fake timers `vi.useFakeTimers()` to make the tests deterministic.
- Keep tests clean and well-structured following the AAA (Arrange, Act, Assert) pattern.

## Anti-Patterns
- Do not modify global `Date` constructor without restoring it using `vi.restoreAllMocks()` or `vi.useRealTimers()`.
- Do not let asynchronous timers linger after the test completes. Always call `timer.destroy()` or `timer.clear()`.

## Mocking Conventions
- Use `vi.fn()` for callback verification.
- Mock specific external dependencies when required, but prefer testing the actual integration when possible.
