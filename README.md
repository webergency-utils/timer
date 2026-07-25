# @webergency-utils/timer

An efficient, accurate, and robust task scheduling and cron timer library for Node.js. It supports interval-based timers, absolute/relative deadlines, cron expressions, custom timezones, and configurable retry backoffs.

[![npm version](https://img.shields.io/npm/v/%40webergency-utils%2Ftimer)](https://www.npmjs.com/package/@webergency-utils/timer)
[![License](https://img.shields.io/npm/l/%40webergency-utils%2Ftimer)](https://www.npmjs.com/package/@webergency-utils/timer)
[![Maintenance](https://img.shields.io/badge/maintenance-active-brightgreen.svg)](#maintenance)
[![dependencies](https://img.shields.io/badge/dependencies-1-brightgreen.svg)](https://www.npmjs.com/package/@webergency-utils/timer?activeTab=dependencies)
[![npm downloads](https://img.shields.io/npm/dm/%40webergency-utils%2Ftimer)](https://www.npmjs.com/package/@webergency-utils/timer)<br>
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/webergency-utils/timer/badge)](https://securityscorecards.dev/viewer/?uri=github.com/webergency-utils/timer)
[![codecov](https://codecov.io/gh/webergency-utils/timer/graph/badge.svg?token=)](https://codecov.io/gh/webergency-utils/timer)
[![CI](https://github.com/webergency-utils/timer/actions/workflows/ci.yml/badge.svg)](https://github.com/webergency-utils/timer/actions/workflows/ci.yml)
[![CodeQL](https://github.com/webergency-utils/timer/actions/workflows/codeql.yml/badge.svg)](https://github.com/webergency-utils/timer/actions/workflows/codeql.yml)

## TL;DR

```typescript
import Timer from '@webergency-utils/timer';

const timer = new Timer();

// 1. Cron-style scheduling: Run every hour at minute 0
timer.set('sync-task', '0 * * * *', ({ id }) => {
  console.log(`Running background sync task: ${id}`);
});

// 2. Interval-style scheduling: Run in 5 seconds, and repeat every 10 seconds
timer.set('poll-task', 5000, ({ id }) => {
  console.log(`Running poll task: ${id}`);
}, { interval: 10000 });
```

## Installation & Setup

Install the package via npm:

```bash
npm install @webergency-utils/timer
```

This package supports both ES Modules (ESM) and CommonJS (CJS) natively. No external peer dependencies or environment configurations are required.

## Architecture & Internals

- **Binary Min-Heap:** The library uses a binary min-heap (`Heap`) under the hood to store and order scheduled tasks efficiently by their nearest firing deadline. This ensures that inserting, updating, or deleting tasks scales efficiently, even with thousands of concurrent schedules.
- **Single Active Timeout:** Instead of spawning multiple node timeouts, a single timer instance manages exactly one `setTimeout` for the nearest upcoming task. When it fires, the queue is dispatched, next deadlines are calculated, and the next timeout is scheduled.
- **Timezone-Aware Cron:** Cron expressions are calculated using modern `Intl.DateTimeFormat` APIs to properly adjust for timezone transitions, daylight saving time (DST) shifts, and UTC offsets.
- **Robust Retries:** Task execution failures (including asynchronous rejections) can trigger automatic retry policies. Retries support constant or exponential backoff with random jitter to prevent thundering herd problems.

## Glossary

- **`Timer`**: The main controller class used to manage a scheduler instance and schedule tasks.
- **`TimerCallback`**: A callback function type triggered when a scheduled task is executed.
- **`TimerOptions`**: Configuration settings for individual tasks (e.g. interval, timezone, offset, retries).
- **`RetryOptions`**: Settings for task retries upon failure (attempts, backoff style, delay).

## API Reference

### `Timer` (Class)

The primary controller for managing tasks.

#### Constructor

```typescript
new Timer( options?: TimerConstructorOptions )
new Timer( name?: string, options?: TimerConstructorOptions )
```

| Parameter | Type | Description |
| :--- | :--- | :--- |
| `name` | `string` | Optional name to identify the timer instance. |
| `options` | `TimerConstructorOptions` | Default configuration applied to all tasks scheduled on this instance. |

---

### Public Methods

#### `set()`

Schedules a new task or updates an existing task with the same `id`.

```typescript
timer.set<Data = any>(
    id       : string,
    deadline : Date | number | string,
    callback : TimerCallback<Data>,
    options? : TimerOptions<Data>
): void
```

| Parameter | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `id` | `string` | *Required* | A unique identifier for this task. |
| `deadline` | `Date \| number \| string` | *Required* | The task schedule. Can be a future `Date`, relative/absolute milliseconds, or a cron string (e.g., `'*/5 * * * *'`). |
| `callback` | `TimerCallback` | *Required* | The function to run when the task triggers. |
| `options` | `TimerOptions` | `{}` | Optional configuration parameters. |

##### `TimerOptions` properties:
*   `offset` (number): Optional offset in milliseconds applied to the deadline (e.g. `-1000` fires 1 second early).
*   `expires` (Date | number): Absolute timestamp or Date when the task automatically expires and stops triggering.
*   `data` (any): Custom user context data passed to the callback function.
*   `interval` (number): Interval in milliseconds for repeating tasks (cannot be combined with cron schedules).
*   `retry` (RetryOptions | null): Task-specific retry settings. Pass `null` to explicitly disable retries.
*   `timezone` (string): Task-specific timezone for cron timers (e.g. `'Europe/Paris'`).

##### Throws
*   `Error` if a cron string deadline is provided alongside an `interval` option.
*   `Error` if `expires` is a relative duration less than the safety limit.

---

#### `postpone()`

Reschedules an existing task to a new deadline.

```typescript
timer.postpone(
    id       : string,
    deadline : Date | number,
    options? : Omit<TimerOptions, 'data' | 'interval'>
): boolean
```

Returns `true` if the task exists and was successfully postponed; otherwise `false`.

---

#### `unset()`

Cancels a scheduled task and removes it from the timer.

```typescript
timer.unset( id: string ): boolean
```

Returns `true` if the task existed and was removed; otherwise `false`.

---

#### `clear()`

Cancels and removes all scheduled tasks.

```typescript
timer.clear(): void
```

---

#### `pause()`

Pauses task execution.

```typescript
timer.pause( id?: string ): boolean | void
```

*   If an `id` is provided, pauses the specific task. Returns `true` if the task was found and paused.
*   If no `id` is provided, pauses all task executions for this timer instance.

---

#### `resume()`

Resumes task execution.

```typescript
timer.resume( id?: string ): boolean | void
```

*   If an `id` is provided, resumes the specific task. Returns `true` if the task was found and resumed.
*   If no `id` is provided, resumes all task executions for this timer instance.

---

#### `destroy()`

Clears all scheduled tasks and cleans up the instance from global registries.

```typescript
timer.destroy(): void
```

---

#### `has()`

Checks if a task with the given ID is registered.

```typescript
timer.has( id: string ): boolean
```

---

#### `ids()`

Returns an array of all registered task IDs.

```typescript
timer.ids(): string[]
```

---

#### `id()`

Utility method to generate a unique task ID string.

```typescript
timer.id( prefix?: string ): string
```

---

### Static Methods

#### `Timer.pause()`

Globally pauses all `Timer` instances. No tasks on any instances will execute until globally resumed.

```typescript
Timer.pause(): void
```

---

#### `Timer.resume()`

Globally resumes all paused `Timer` instances.

```typescript
Timer.resume(): void
```

---

#### `Timer.id()`

Generates a unique ID string. Useful for generating IDs for task scheduling.

```typescript
Timer.id( prefix?: string ): string
```

---

### Configuration Interfaces & Types

#### `TimerConstructorOptions`

```typescript
type TimerConstructorOptions = {
    timezone? : string
    retry?    : RetryOptions
}
```

#### `RetryOptions`

```typescript
type RetryOptions = {
    attempts? : number
    delay?    : number
    backoff?  : 'constant' | 'exponential'
}
```

#### `TimerCallback`

```typescript
type TimerCallback<Data = any> = (
    context : {
        id   : string
        data : Data
    }
) => any
```

---

## Maintenance

This package is actively maintained.

Bug reports and pull requests are welcome. Security issues and critical
regressions are prioritized. New features are considered when they align
with the package's existing scope.
