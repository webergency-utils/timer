import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import Timer from '../timer';
import { getNextCronDate } from '../cron';

describe( 'Timer tests', () =>
{
    beforeEach( () =>
    {
        vi.useFakeTimers();
    });

    afterEach( () =>
    {
        vi.restoreAllMocks();
    });

    test( 'should generate unique IDs', () =>
    {
        const id1 = Timer.id( 'pref_' );
        const id2 = Timer.id( 'pref_' );

        expect( id1 ).not.toBe( id2 );
        expect( id1.startsWith( 'pref_' ) ).toBe( true );

        const timer = new Timer();
        const id3 = timer.id( 'inst_' );

        expect( id3.startsWith( 'inst_' ) ).toBe( true );
    });

    test( 'should allow creating multiple timers with the same name', () =>
    {
        const name = 'shared-name';
        const t1 = new Timer( name );
        const t2 = new Timer( name );

        expect( t1 ).toBeInstanceOf( Timer );
        expect( t2 ).toBeInstanceOf( Timer );
        expect( t1 ).not.toBe( t2 );

        t1.destroy();
        t2.destroy();
    });

    test( 'should accept constructor default options and propagate them', () =>
    {
        vi.setSystemTime( new Date( '2026-06-20T12:00:00Z' ) );

        const defaultRetry = { attempts: 3, delay: 100, backoff: 'constant' as const };
        const timer = new Timer( { timezone: 'Europe/Prague', retry: defaultRetry } );
        const cb = vi.fn();

        // 1. Verify cron timezone uses constructor default
        timer.set( 'tzTask', '0 12 * * *', cb ); // Europe/Prague is UTC+2 in summer, so 12:00 in Prague is 10:00 UTC
        vi.advanceTimersByTime( 22 * 3600 * 1000 ); // Advance to next day 10:00 UTC
        expect( cb ).toHaveBeenCalledTimes( 1 );

        timer.destroy();
    });

    test( 'should validate default timezone in constructor and throw if invalid', () =>
    {
        expect( () => new Timer( { timezone: 'Invalid/Zone' } ) ).toThrow( 'Invalid timezone: Invalid/Zone' );
        expect( () => new Timer( 'some-name', { timezone: 'Invalid/Zone' } ) ).toThrow( 'Invalid timezone: Invalid/Zone' );
    });

    test( 'should fire callback when deadline is reached', () =>
    {
        const timer = new Timer();
        const callback = vi.fn();

        timer.set( 'task1', 1000, callback );

        expect( callback ).not.toHaveBeenCalled();

        vi.advanceTimersByTime( 999 );

        expect( callback ).not.toHaveBeenCalled();

        vi.advanceTimersByTime( 20 );

        expect( callback ).toHaveBeenCalledTimes( 1 );
    });

    test( 'should pass custom data to the callback', () =>
    {
        const timer = new Timer();
        const callback = vi.fn();
        const testData = { message: 'hello world' };

        timer.set( 'task1', 500, callback, { data: testData } );

        vi.advanceTimersByTime( 500 );

        expect( callback ).toHaveBeenCalledWith( { id: 'task1', data: testData } );
    });

    test( 'should apply offset and expires correctly', () =>
    {
        const timer = new Timer();
        const callback = vi.fn();

        timer.set( 'task1', 500, callback, { offset: 100 } );

        vi.advanceTimersByTime( 550 );

        expect( callback ).not.toHaveBeenCalled();

        vi.advanceTimersByTime( 60 );

        expect( callback ).toHaveBeenCalledTimes( 1 );
    });

    test( 'should not fire if expires deadline has already passed significantly (expires option)', () =>
    {
        const timer = new Timer();
        const callback = vi.fn();
        const now = Date.now();

        timer.set( 'task1', now + 500, callback, { expires: now + 550 } );

        const dateSpy = vi.spyOn( Date, 'now' ).mockReturnValue( now + 700 );

        vi.advanceTimersByTime( 500 );

        expect( callback ).not.toHaveBeenCalled();

        dateSpy.mockRestore();
    });

    test( 'should postpone an existing timer', () =>
    {
        const timer = new Timer();
        const callback = vi.fn();

        timer.set( 'task1', 500, callback );

        const postponed = timer.postpone( 'task1', 1000 );

        expect( postponed ).toBe( true );

        vi.advanceTimersByTime( 600 );

        expect( callback ).not.toHaveBeenCalled();

        vi.advanceTimersByTime( 450 );

        expect( callback ).toHaveBeenCalledTimes( 1 );
    });

    test( 'should fail to postpone a non-existent timer', () =>
    {
        const timer = new Timer();
        const postponed = timer.postpone( 'nonexistent', 1000 );

        expect( postponed ).toBe( false );
    });

    test( 'should unset an existing timer', () =>
    {
        const timer = new Timer();
        const callback = vi.fn();

        timer.set( 'task1', 500, callback );

        const unsetResult = timer.unset( 'task1' );

        expect( unsetResult ).toBe( true );

        vi.advanceTimersByTime( 600 );

        expect( callback ).not.toHaveBeenCalled();
    });

    test( 'should return false when unsetting non-existent timer', () =>
    {
        const timer = new Timer();

        expect( timer.unset( 'nonexistent' ) ).toBe( false );
    });

    test( 'should clear all timers', () =>
    {
        const timer = new Timer();
        const cb1 = vi.fn();
        const cb2 = vi.fn();

        timer.set( 't1', 500, cb1 );
        timer.set( 't2', 800, cb2 );

        timer.clear();

        vi.advanceTimersByTime( 1000 );

        expect( cb1 ).not.toHaveBeenCalled();
        expect( cb2 ).not.toHaveBeenCalled();
    });

    test( 'should respect pause and resume', () =>
    {
        const timer = new Timer();
        const callback = vi.fn();

        timer.set( 'task1', 500, callback );

        timer.pause();

        vi.advanceTimersByTime( 600 );

        expect( callback ).not.toHaveBeenCalled();

        timer.resume();

        vi.advanceTimersByTime( 50 );

        expect( callback ).toHaveBeenCalledTimes( 1 );
    });

    test( 'should destroy instance safely', () =>
    {
        const timer = new Timer();
        const callback = vi.fn();

        timer.set( 'task1', 500, callback );

        timer.destroy();

        vi.advanceTimersByTime( 1000 );

        expect( callback ).not.toHaveBeenCalled();
    });

    describe( 'Cron parsing and scheduling', () =>
    {
        test( 'should calculate next cron dates correctly', () =>
        {
            const baseDate = new Date( '2026-06-20T12:00:15.000Z' );
            const d1 = getNextCronDate( '* * * * *', baseDate );

            expect( d1.getMinutes() ).toBe( 1 );
            expect( d1.getSeconds() ).toBe( 0 );

            const d2 = getNextCronDate( '*/5 * * * *', baseDate );

            expect( d2.getMinutes() ).toBe( 5 );
            expect( d2.getSeconds() ).toBe( 0 );

            const d3 = getNextCronDate( '0 9 * * 1-5', baseDate );

            expect( d3.getDay() ).toBe( 1 );
            expect( d3.getHours() ).toBe( 9 );
            expect( d3.getMinutes() ).toBe( 0 );

            const d4 = getNextCronDate( '0 0 1 1 *', baseDate );

            expect( d4.getMonth() ).toBe( 0 );
            expect( d4.getDate() ).toBe( 1 );
            expect( d4.getHours() ).toBe( 0 );
            expect( d4.getMinutes() ).toBe( 0 );

            const d5 = getNextCronDate( '0 0 1 jan *', baseDate );

            expect( d5.getMonth() ).toBe( 0 );
            expect( d5.getDate() ).toBe( 1 );

            const d6 = getNextCronDate( '0 9 * * mon', baseDate );

            expect( d6.getDay() ).toBe( 1 );
            expect( d6.getHours() ).toBe( 9 );
        });

        test( 'should schedule a cron timer and fire repeatedly', () =>
        {
            vi.setSystemTime( new Date( '2026-06-20T12:00:00.000Z' ) );

            const timer = new Timer();
            const callback = vi.fn();

            timer.set( 'cronTask', '* * * * *', callback );

            vi.advanceTimersByTime( 60 * 1000 );

            expect( callback ).toHaveBeenCalledTimes( 1 );

            vi.advanceTimersByTime( 60 * 1000 );

            expect( callback ).toHaveBeenCalledTimes( 2 );

            vi.advanceTimersByTime( 3 * 60 * 1000 );

            expect( callback ).toHaveBeenCalledTimes( 5 );
        });

        test( 'should unset a cron timer and stop execution', () =>
        {
            vi.setSystemTime( new Date( '2026-06-20T12:00:00.000Z' ) );

            const timer = new Timer();
            const callback = vi.fn();

            timer.set( 'cronTask', '* * * * *', callback );

            vi.advanceTimersByTime( 60 * 1000 );

            expect( callback ).toHaveBeenCalledTimes( 1 );

            timer.unset( 'cronTask' );

            vi.advanceTimersByTime( 2 * 60 * 1000 );

            expect( callback ).toHaveBeenCalledTimes( 1 );
        });

        test( 'should support postponing a cron timer', () =>
        {
            vi.setSystemTime( new Date( '2026-06-20T12:00:00.000Z' ) );

            const timer = new Timer();
            const callback = vi.fn();

            timer.set( 'cronTask', '* * * * *', callback );

            const postponedDate = new Date( '2026-06-20T12:01:30.000Z' );

            timer.postpone( 'cronTask', postponedDate );

            vi.advanceTimersByTime( 65 * 1000 );

            expect( callback ).not.toHaveBeenCalled();

            vi.advanceTimersByTime( 30 * 1000 );

            expect( callback ).toHaveBeenCalledTimes( 1 );

            vi.advanceTimersByTime( 30 * 1000 );

            expect( callback ).toHaveBeenCalledTimes( 2 );
        });
    });

    describe( 'Interval scheduling', () =>
    {
        test( 'should schedule a recurring interval timer', () =>
        {
            const timer = new Timer();
            const callback = vi.fn();

            timer.set( 'intervalTask', 500, callback, { interval: 200 } );

            vi.advanceTimersByTime( 499 );

            expect( callback ).not.toHaveBeenCalled();

            vi.advanceTimersByTime( 2 ); // fires first time at 500ms

            expect( callback ).toHaveBeenCalledTimes( 1 );

            vi.advanceTimersByTime( 200 ); // fires second time at 700ms

            expect( callback ).toHaveBeenCalledTimes( 2 );

            vi.advanceTimersByTime( 200 ); // fires third time at 900ms

            expect( callback ).toHaveBeenCalledTimes( 3 );
        });

        test( 'should throw an error if cron has an interval option', () =>
        {
            const timer = new Timer();
            const callback = vi.fn();

            expect( () => timer.set( 'task', '* * * * *', callback, { interval: 100 } ) )
                .toThrowError( 'Cron timers cannot have an interval option.' );
        });

        test( 'should unset an interval timer and stop execution', () =>
        {
            const timer = new Timer();
            const callback = vi.fn();

            timer.set( 'intervalTask', 500, callback, { interval: 200 } );

            vi.advanceTimersByTime( 500 );

            expect( callback ).toHaveBeenCalledTimes( 1 );

            timer.unset( 'intervalTask' );

            vi.advanceTimersByTime( 1000 );

            expect( callback ).toHaveBeenCalledTimes( 1 );
        });

        test( 'should support postponing an interval timer', () =>
        {
            const timer = new Timer();
            const callback = vi.fn();

            timer.set( 'intervalTask', 500, callback, { interval: 200 } );

            timer.postpone( 'intervalTask', 800 );

            vi.advanceTimersByTime( 790 );

            expect( callback ).not.toHaveBeenCalled();

            vi.advanceTimersByTime( 15 ); // fires at 800ms

            expect( callback ).toHaveBeenCalledTimes( 1 );

            vi.advanceTimersByTime( 200 ); // fires at 1000ms

            expect( callback ).toHaveBeenCalledTimes( 2 );
        });

        test( 'should handle system delay without catch-up cascades', () =>
        {
            vi.setSystemTime( 0 );

            const timer = new Timer();
            const callback = vi.fn();

            // Scheduled at 100, interval 100
            timer.set( 'intervalTask', 100, callback, { interval: 100 } );

            // Delay execution tick until 250ms (now = 250)
            vi.setSystemTime( 250 );
            vi.runOnlyPendingTimers();

            expect( callback ).toHaveBeenCalledTimes( 1 );

            // Next execution should align to 300ms (skipping 200ms)
            vi.advanceTimersByTime( 45 ); // clock is 295ms

            expect( callback ).toHaveBeenCalledTimes( 1 );

            vi.advanceTimersByTime( 10 ); // clock is 305ms

            expect( callback ).toHaveBeenCalledTimes( 2 );
        });
    });

    describe( 'Async callback execution', () =>
    {
        test( 'should wait for async callback and schedule next tick relative to end time', async () =>
        {
            vi.setSystemTime( 0 );

            const timer = new Timer();
            let resolveFunc: () => void = () => {};
            const callback = vi.fn( () =>
            {
                return new Promise<void>( ( resolve ) =>
                {
                    resolveFunc = resolve;
                });
            });

            timer.set( 'asyncTask', 500, callback, { interval: 200 } );

            vi.advanceTimersByTime( 500 );

            expect( callback ).toHaveBeenCalledTimes( 1 );

            vi.setSystemTime( 650 );
            resolveFunc();
            await Promise.resolve();

            vi.advanceTimersByTime( 150 ); // Clock is 800ms

            expect( callback ).toHaveBeenCalledTimes( 1 );

            vi.advanceTimersByTime( 60 ); // Clock is 860ms

            expect( callback ).toHaveBeenCalledTimes( 2 );
        });

        test( 'should support canceling an actively running async timer', async () =>
        {
            vi.setSystemTime( 0 );

            const timer = new Timer();
            let resolveFunc: () => void = () => {};
            const callback = vi.fn( () =>
            {
                return new Promise<void>( ( resolve ) =>
                {
                    resolveFunc = resolve;
                });
            });

            timer.set( 'asyncTask', 500, callback, { interval: 200 } );

            vi.advanceTimersByTime( 500 );

            expect( callback ).toHaveBeenCalledTimes( 1 );

            timer.unset( 'asyncTask' );

            resolveFunc();
            await Promise.resolve();

            vi.advanceTimersByTime( 1000 );

            expect( callback ).toHaveBeenCalledTimes( 1 );
        });

        test( 'should support postponing an actively running async timer', async () =>
        {
            vi.setSystemTime( 0 );

            const timer = new Timer();
            let resolveFunc: () => void = () => {};
            const callback = vi.fn( () =>
            {
                return new Promise<void>( ( resolve ) =>
                {
                    resolveFunc = resolve;
                });
            });

            timer.set( 'asyncTask', 500, callback, { interval: 200 } );

            vi.advanceTimersByTime( 500 );

            expect( callback ).toHaveBeenCalledTimes( 1 );

            vi.advanceTimersByTime( 50 ); // clock is 550ms
            timer.postpone( 'asyncTask', new Date( 1000 ) );

            vi.advanceTimersByTime( 100 ); // clock is 650ms
            resolveFunc();
            await Promise.resolve();

            vi.advanceTimersByTime( 300 ); // clock is 950ms

            expect( callback ).not.toHaveBeenCalledTimes( 2 );

            vi.advanceTimersByTime( 100 ); // clock is 1050ms

            expect( callback ).toHaveBeenCalledTimes( 2 );
        });
    });

    describe( 'Advanced Cron features', () =>
    {
        test( 'should parse abbreviations, wildcards, ranges and steps correctly', () =>
        {
            const next = getNextCronDate( '0 12 * jan-dec/2 mon-fri/2', new Date( '2026-01-01T00:00:00Z' ) );

            expect( next ).toBeInstanceOf( Date );
        });

        test( 'should support ? character as wildcard', () =>
        {
            const next1 = getNextCronDate( '0 12 ? * *', new Date( '2026-01-01T00:00:00Z' ) );
            const next2 = getNextCronDate( '0 12 * * ?', new Date( '2026-01-01T00:00:00Z' ) );

            expect( next1.getHours() ).toBe( 12 );
            expect( next2.getHours() ).toBe( 12 );
            expect( next1.getDate() ).toBe( 1 );
            expect( next2.getDate() ).toBe( 1 );
        });

        test( 'should support L qualifier for last day of month', () =>
        {
            const next = getNextCronDate( '0 12 L * *', new Date( '2026-01-01T00:00:00Z' ) );

            expect( next.getHours() ).toBe( 12 );
            expect( next.getDate() ).toBe( 31 );
        });

        test( 'should support LW qualifier for last weekday of month', () =>
        {
            const next = getNextCronDate( '0 12 LW * *', new Date( '2026-02-01T00:00:00Z' ) );

            expect( next.getHours() ).toBe( 12 );
            expect( next.getDate() ).toBe( 27 );
        });

        test( 'should support W qualifier for nearest weekday', () =>
        {
            const next = getNextCronDate( '0 12 15W * *', new Date( '2026-02-01T00:00:00Z' ) );

            expect( next.getHours() ).toBe( 12 );
            expect( next.getDate() ).toBe( 16 );
        });

        test( 'should support # qualifier for nth occurrence of day-of-week in month', () =>
        {
            const next = getNextCronDate( '0 12 * * 5#3', new Date( '2026-02-01T00:00:00Z' ) );

            expect( next.getHours() ).toBe( 12 );
            expect( next.getDate() ).toBe( 20 );
        });

        test( 'should throw syntax error immediately on malformed expression during set', () =>
        {
            const timer = new Timer();
            const callback = vi.fn();

            expect( () => timer.set( 'task', 'invalid cron expr here', callback ) ).toThrow();
            expect( () => timer.set( 'task', '0 12 32 * *', callback ) ).toThrow();
            expect( () => timer.set( 'task', '0-1-2 12 * * *', callback ) ).toThrow();
            expect( () => timer.set( 'task', '0 12 * * mon-wed-fri', callback ) ).toThrow();
        });
    });

    describe( 'Async retry policy', () =>
    {
        beforeEach( () =>
        {
            vi.spyOn( Math, 'random' ).mockReturnValue( 0.5 );
        });

        test( 'should retry on failure and eventually succeed if target success attempt is reached', async () =>
        {
            vi.setSystemTime( 0 );

            const timer = new Timer();
            let attempts = 0;
            const callback = vi.fn( () =>
            {
                attempts++;
                if( attempts < 3 )
                {
                    return Promise.reject( new Error( 'Failing' ) );
                }

                return Promise.resolve( 'Success' );
            });

            timer.set( 'retryTask', 500, callback, {
                retry: {
                    attempts: 3,
                    delay: 100,
                    backoff: 'constant'
                }
            });

            vi.advanceTimersByTime( 500 );

            expect( callback ).toHaveBeenCalledTimes( 1 );
            await Promise.resolve();
            await Promise.resolve();

            vi.advanceTimersByTime( 100 );

            expect( callback ).toHaveBeenCalledTimes( 2 );
            await Promise.resolve();
            await Promise.resolve();

            vi.advanceTimersByTime( 100 );

            expect( callback ).toHaveBeenCalledTimes( 3 );
            await Promise.resolve();
            await Promise.resolve();

            vi.advanceTimersByTime( 1000 );

            expect( callback ).toHaveBeenCalledTimes( 3 );
        });

        test( 'should support exponential backoff on retries', async () =>
        {
            vi.setSystemTime( 0 );

            const timer = new Timer();
            const callback = vi.fn( () => Promise.reject( new Error( 'Always failing' ) ) );

            timer.set( 'retryTask', 500, callback, {
                retry: {
                    attempts: 3,
                    delay: 100,
                    backoff: 'exponential'
                }
            });

            vi.advanceTimersByTime( 500 );

            expect( callback ).toHaveBeenCalledTimes( 1 );
            await Promise.resolve();
            await Promise.resolve();

            vi.advanceTimersByTime( 99 );

            expect( callback ).toHaveBeenCalledTimes( 1 );

            vi.advanceTimersByTime( 1 );

            expect( callback ).toHaveBeenCalledTimes( 2 );
            await Promise.resolve();
            await Promise.resolve();

            vi.advanceTimersByTime( 199 );

            expect( callback ).toHaveBeenCalledTimes( 2 );

            vi.advanceTimersByTime( 1 );

            expect( callback ).toHaveBeenCalledTimes( 3 );
            await Promise.resolve();
            await Promise.resolve();

            vi.advanceTimersByTime( 1000 );

            expect( callback ).toHaveBeenCalledTimes( 4 );
        });

        test( 'should clone retry options to prevent external mutations from affecting the timer', async () =>
        {
            vi.setSystemTime( 0 );

            const timer = new Timer();
            const callback = vi.fn( () => Promise.reject( new Error( 'Failing' ) ) );
            const retryOpts = { attempts: 3, delay: 100, backoff: 'constant' as const };

            timer.set( 'retryTask', 500, callback, { retry: retryOpts } );

            retryOpts.attempts = 0;
            retryOpts.delay = 0;

            vi.advanceTimersByTime( 500 );

            expect( callback ).toHaveBeenCalledTimes( 1 );
            await Promise.resolve();
            await Promise.resolve();

            vi.advanceTimersByTime( 100 );

            expect( callback ).toHaveBeenCalledTimes( 2 );
            await Promise.resolve();
            await Promise.resolve();
        });

        test( 'should reschedule interval/cron tasks after all retry attempts fail', async () =>
        {
            vi.setSystemTime( 0 );

            const timer = new Timer();
            const callback = vi.fn( () => Promise.reject( new Error( 'Always failing' ) ) );

            timer.set( 'intervalRetryTask', 500, callback, {
                interval : 1000,
                retry    : {
                    attempts : 2,
                    delay    : 100,
                    backoff  : 'constant'
                }
            });

            // 1. Initial execution at 500ms (fails, 1st retry scheduled for 600ms)
            vi.advanceTimersByTime( 500 );

            expect( callback ).toHaveBeenCalledTimes( 1 );
            await Promise.resolve();
            await Promise.resolve();

            // 2. 1st retry execution at 600ms (fails, 2nd retry scheduled for 700ms)
            vi.advanceTimersByTime( 100 );

            expect( callback ).toHaveBeenCalledTimes( 2 );
            await Promise.resolve();
            await Promise.resolve();

            // 3. 2nd retry execution at 700ms (fails, retries exhausted, next interval scheduled for 1700ms)
            vi.advanceTimersByTime( 100 );

            expect( callback ).toHaveBeenCalledTimes( 3 );
            await Promise.resolve();
            await Promise.resolve();

            // 4. Advance time to 1699ms - should not have executed again yet
            vi.advanceTimersByTime( 999 );

            expect( callback ).toHaveBeenCalledTimes( 3 );

            // 5. Advance time to 1700ms - next interval execution occurs
            vi.advanceTimersByTime( 1 );

            expect( callback ).toHaveBeenCalledTimes( 4 );
        });

        test( 'should cap retry backoff deadline to initial attempt end + interval and skip retries if exceeded', async () =>
        {
            vi.setSystemTime( 0 );

            const timer = new Timer();
            const callback = vi.fn( () => Promise.reject( new Error( 'Always failing' ) ) );

            timer.set( 'intervalCapTask', 500, callback, {
                interval : 1000,
                retry    : {
                    attempts : 3,
                    delay    : 600,
                    backoff  : 'exponential'
                }
            });

            // 1. Initial execution at 500ms (fails, 1st retry scheduled for 1100ms)
            vi.advanceTimersByTime( 500 );

            expect( callback ).toHaveBeenCalledTimes( 1 );
            await Promise.resolve();
            await Promise.resolve();

            // 2. 1st retry execution at 1100ms (fails)
            // Attempt 2 backoff is 600 * 2 = 1200ms -> retryDeadline is 1100 + 1200 = 2300ms.
            // Next regular firing is 500 (initial end) + 1000 (interval) = 1500ms.
            // Since 2300 >= 1500, it should not retry at 2300ms but schedule at 1500ms instead.
            vi.advanceTimersByTime( 600 );

            expect( callback ).toHaveBeenCalledTimes( 2 );
            await Promise.resolve();
            await Promise.resolve();

            // 3. Advance to 1499ms - should not run
            vi.advanceTimersByTime( 399 );

            expect( callback ).toHaveBeenCalledTimes( 2 );

            // 4. Advance to 1500ms - next regular firing runs
            vi.advanceTimersByTime( 1 );

            expect( callback ).toHaveBeenCalledTimes( 3 );
        });

        test( 'should cap retry backoff deadline to next cron execution time and skip retries if exceeded', async () =>
        {
            vi.setSystemTime( new Date( '2026-06-20T11:59:00Z' ).getTime() );

            const timer = new Timer();
            const callback = vi.fn( () => Promise.reject( new Error( 'Always failing' ) ) );

            timer.set( 'cronCapTask', '* * * * *', callback, {
                retry : {
                    attempts : 3,
                    delay    : 45000,
                    backoff  : 'exponential'
                }
            });

            vi.advanceTimersByTime( 60000 ); // Advance to 12:00:00

            expect( callback ).toHaveBeenCalledTimes( 1 );
            await Promise.resolve();
            await Promise.resolve();

            // 2. 1st retry execution at 12:00:45 (fails)
            // Attempt 2 backoff is 45s * 2 = 90s -> retryDeadline is 12:00:45 + 90s = 12:02:15.
            // Next regular cron is 12:01:00.
            // Since 12:02:15 >= 12:01:00, it should skip retry and schedule at 12:01:00.
            vi.advanceTimersByTime( 45000 ); // Advance to 12:00:45

            expect( callback ).toHaveBeenCalledTimes( 2 );
            await Promise.resolve();
            await Promise.resolve();

            // 3. Advance to 12:00:59 - should not run
            vi.advanceTimersByTime( 14000 );

            expect( callback ).toHaveBeenCalledTimes( 2 );

            // 4. Advance to 12:01:00 - next regular cron execution runs
            vi.advanceTimersByTime( 1000 );

            expect( callback ).toHaveBeenCalledTimes( 3 );
        });

        test( 'should allow turning off retry attempt by passing retry: null when constructor has default retry configured', async () =>
        {
            vi.setSystemTime( 0 );

            const defaultRetry = { attempts: 3, delay: 100, backoff: 'constant' as const };
            const timer = new Timer( { retry: defaultRetry } );
            const callback = vi.fn( () => Promise.reject( new Error( 'Failing' ) ) );

            // Schedule task1 with retry explicitly set to null
            timer.set( 'noRetryTask', 500, callback, { retry: null } );

            vi.advanceTimersByTime( 500 );

            expect( callback ).toHaveBeenCalledTimes( 1 );
            await Promise.resolve();
            await Promise.resolve();

            // Advance further to see that it did NOT retry
            vi.advanceTimersByTime( 500 );
            expect( callback ).toHaveBeenCalledTimes( 1 );

            timer.destroy();
        });
    });

    describe( 'Timezone-aware Cron scheduling', () =>
    {
        test( 'should throw an error for unknown timezone', () =>
        {
            expect( () => getNextCronDate( '* * * * *', new Date(), 'Invalid/Zone' ) ).toThrowError( 'Invalid timezone: Invalid/Zone' );
        });

        test( 'should calculate next cron date in UTC', () =>
        {
            const baseDate = new Date( '2026-06-20T00:00:00Z' );
            const next = getNextCronDate( '0 12 * * *', baseDate, 'UTC' );

            expect( next.getUTCHours() ).toBe( 12 );
            expect( next.getUTCMinutes() ).toBe( 0 );
        });

        test( 'should calculate next cron date in America/New_York', () =>
        {
            const baseDate = new Date( '2026-06-20T12:00:00Z' );
            const next = getNextCronDate( '0 12 * * *', baseDate, 'America/New_York' );

            const formatter = new Intl.DateTimeFormat( 'en-US', {
                timeZone : 'America/New_York',
                hour     : 'numeric',
                hour12   : false
            });

            expect( formatter.format( next ) ).toBe( '12' );
        });

        test( 'should schedule and trigger timer using timezone', () =>
        {
            vi.setSystemTime( new Date( '2026-06-20T12:00:00Z' ) );

            const timer = new Timer();
            const callback = vi.fn();

            timer.set( 'tzTask', '0 12 * * *', callback, { timezone: 'America/New_York' } );

            vi.advanceTimersByTime( 3 * 3600 * 1000 );

            expect( callback ).not.toHaveBeenCalled();

            vi.advanceTimersByTime( 1 * 3600 * 1000 );

            expect( callback ).toHaveBeenCalledTimes( 1 );
        });
    });

    describe( 'Clock drift wake-from-sleep', () =>
    {
        test( 'should run overdue task immediately if system clock jumps significantly', () =>
        {
            vi.setSystemTime( 0 );

            const timer = new Timer();
            const callback = vi.fn();

            timer.set( 'task1', 50000, callback );

            vi.setSystemTime( 120000 );

            vi.advanceTimersByTime( 60000 );

            expect( callback ).toHaveBeenCalledTimes( 1 );
        });
    });

    describe( 'Specific Timer Pause and Resume', () =>
    {
        test( 'should pause specific timer', () =>
        {
            const timer = new Timer();
            const cb1 = vi.fn();
            const cb2 = vi.fn();

            timer.set( 'task1', 500, cb1 );
            timer.set( 'task2', 800, cb2 );

            const paused = timer.pause( 'task1' );

            expect( paused ).toBe( true );

            vi.advanceTimersByTime( 1000 );

            expect( cb1 ).not.toHaveBeenCalled();
            expect( cb2 ).toHaveBeenCalledTimes( 1 );
        });

        test( 'should resume specific paused timer', () =>
        {
            const timer = new Timer();
            const cb = vi.fn();

            timer.set( 'task1', 500, cb );
            timer.pause( 'task1' );

            vi.advanceTimersByTime( 600 );

            expect( cb ).not.toHaveBeenCalled();

            const resumed = timer.resume( 'task1' );

            expect( resumed ).toBe( true );

            vi.advanceTimersByTime( 50 );

            expect( cb ).toHaveBeenCalledTimes( 1 );
        });

        test( 'should unpause and reschedule on set()', () =>
        {
            const timer = new Timer();
            const cb = vi.fn();

            timer.set( 'task1', 500, cb );
            timer.pause( 'task1' );

            timer.set( 'task1', 800, cb );

            vi.advanceTimersByTime( 750 );

            expect( cb ).not.toHaveBeenCalled();

            vi.advanceTimersByTime( 100 );

            expect( cb ).toHaveBeenCalledTimes( 1 );
        });
    });

    describe( 'Global static pause and resume', () =>
    {
        test( 'should pause and resume all instances globally without overwriting specific pauses', () =>
        {
            vi.setSystemTime( 0 );

            const t1 = new Timer( 't1' );
            const t2 = new Timer( 't2' );
            const cb1 = vi.fn();
            const cb2 = vi.fn();

            t1.set( 'task1', 500, cb1 );
            t2.set( 'task2', 500, cb2 );

            t1.pause();
            Timer.pause();

            vi.advanceTimersByTime( 600 );

            expect( cb1 ).not.toHaveBeenCalled();
            expect( cb2 ).not.toHaveBeenCalled();

            Timer.resume();

            vi.advanceTimersByTime( 50 );

            expect( cb1 ).not.toHaveBeenCalled();
            expect( cb2 ).toHaveBeenCalledTimes( 1 );

            t1.resume();
            vi.advanceTimersByTime( 500 );

            expect( cb1 ).toHaveBeenCalledTimes( 1 );

            t1.destroy();
            t2.destroy();
        });

        test( 'should keep instances paused during global pause even if individual resume is called', () =>
        {
            vi.setSystemTime( 0 );

            const t1 = new Timer( 't1' );
            const cb = vi.fn();

            t1.set( 'task', 500, cb );

            Timer.pause();

            vi.advanceTimersByTime( 600 );

            expect( cb ).not.toHaveBeenCalled();

            t1.resume();

            vi.advanceTimersByTime( 50 );

            expect( cb ).not.toHaveBeenCalled();

            Timer.resume();

            vi.advanceTimersByTime( 500 );

            expect( cb ).toHaveBeenCalledTimes( 1 );

            t1.destroy();
        });
    });

    describe( 'Introspection APIs', () =>
    {
        test( 'should verify has() and ids() correctly reflect active timers', () =>
        {
            const timer = new Timer();

            expect( timer.has( 'task1' ) ).toBe( false );
            expect( timer.ids() ).toEqual( [] );

            timer.set( 'task1', 500, () => {} );
            timer.set( 'task2', 1000, () => {} );

            expect( timer.has( 'task1' ) ).toBe( true );
            expect( timer.has( 'task2' ) ).toBe( true );
            expect( timer.has( 'nonexistent' ) ).toBe( false );
            expect( timer.ids().sort() ).toEqual( [ 'task1', 'task2' ] );

            timer.unset( 'task1' );

            expect( timer.has( 'task1' ) ).toBe( false );
            expect( timer.has( 'task2' ) ).toBe( true );
            expect( timer.ids() ).toEqual( [ 'task2' ] );
        });
    });

    describe( 'Retry Jitter', () =>
    {
        test( 'should apply ±10% automatic jitter to retries', async () =>
        {
            // Test minimum jitter (-10%): Math.random() = 0.0 -> delay is 900ms
            {
                vi.spyOn( Math, 'random' ).mockReturnValue( 0.0 );
                vi.setSystemTime( 0 );

                const timer = new Timer();
                const callback = vi.fn( () => Promise.reject( new Error( 'Failing' ) ) );

                timer.set( 'retryJitterTask', 500, callback, {
                    retry : {
                        attempts : 1,
                        delay    : 1000,
                        backoff  : 'constant'
                    }
                });

                vi.advanceTimersByTime( 500 );

                expect( callback ).toHaveBeenCalledTimes( 1 );
                await Promise.resolve();
                await Promise.resolve();

                vi.advanceTimersByTime( 899 );

                expect( callback ).not.toHaveBeenCalledTimes( 2 );

                vi.advanceTimersByTime( 1 );

                expect( callback ).toHaveBeenCalledTimes( 2 );
                timer.destroy();
            }

            // Test maximum jitter (+10%): Math.random() = 0.9999 -> delay is approx 1100ms
            {
                vi.spyOn( Math, 'random' ).mockReturnValue( 0.9999 );
                vi.setSystemTime( 0 );

                const timer = new Timer();
                const callback = vi.fn( () => Promise.reject( new Error( 'Failing' ) ) );

                timer.set( 'retryJitterTask', 500, callback, {
                    retry : {
                        attempts : 1,
                        delay    : 1000,
                        backoff  : 'constant'
                    }
                });

                vi.advanceTimersByTime( 500 );

                expect( callback ).toHaveBeenCalledTimes( 1 );
                await Promise.resolve();
                await Promise.resolve();

                vi.advanceTimersByTime( 1099 );

                expect( callback ).not.toHaveBeenCalledTimes( 2 );

                vi.advanceTimersByTime( 1 );

                expect( callback ).toHaveBeenCalledTimes( 2 );
                timer.destroy();
            }
        });
    });

    describe( 'Expiry validation', () =>
    {
        test( 'should throw an error if expires is <= MAX_TIMEOUT_MS', () =>
        {
            const timer = new Timer();

            expect( () => timer.set( 'task1', 500, () => {}, { expires: 1000 } ) ).toThrowError( 'Expiry time must be an absolute timestamp or Date.' );

            timer.set( 'task1', 500, () => {} );

            expect( () => timer.postpone( 'task1', 500, { expires: 1000 } ) ).toThrowError( 'Expiry time must be an absolute timestamp or Date.' );
        });

        test( 'should not schedule the timer and should remove existing one if expires is in the past', () =>
        {
            const baseTime = 2000000000000;
            vi.setSystemTime( baseTime );

            const timer = new Timer();
            const cb = vi.fn();

            // Set a timer that is already expired
            timer.set( 'task1', baseTime + 1000, cb, { expires: baseTime - 1000 } );

            expect( timer.has( 'task1' ) ).toBe( false );

            // Set a valid timer
            timer.set( 'task1', baseTime + 1000, cb, { expires: baseTime + 2000 } );

            expect( timer.has( 'task1' ) ).toBe( true );

            // Update with an expired expires value
            timer.set( 'task1', baseTime + 1000, cb, { expires: baseTime - 500 } );

            expect( timer.has( 'task1' ) ).toBe( false );
        });

        test( 'should remove timer and return false in postpone() if expires is in the past', () =>
        {
            const baseTime = 2000000000000;
            vi.setSystemTime( baseTime );

            const timer = new Timer();
            const cb = vi.fn();

            timer.set( 'task1', baseTime + 1000, cb );

            expect( timer.has( 'task1' ) ).toBe( true );

            const postponed = timer.postpone( 'task1', baseTime + 2000, { expires: baseTime - 500 } );

            expect( postponed ).toBe( false );
            expect( timer.has( 'task1' ) ).toBe( false );
        });
    });

    describe( 'Additional Coverage', () =>
    {
        test( 'should calculate next regular firing for synchronous interval task on retry', () =>
        {
            vi.setSystemTime( 0 );
            vi.spyOn( Math, 'random' ).mockReturnValue( 0.5 ); // jitter is 0

            const timer = new Timer();
            const callback = vi.fn( () => { throw new Error( 'Sync error' ); } );

            timer.set( 'syncIntervalRetryTask', 500, callback, {
                interval : 1000,
                retry    : {
                    attempts : 2,
                    delay    : 100,
                    backoff  : 'constant'
                }
            });

            vi.advanceTimersByTime( 500 );
            expect( callback ).toHaveBeenCalledTimes( 1 );

            // Advance to retry time (500 + 100 = 600)
            vi.advanceTimersByTime( 100 );
            expect( callback ).toHaveBeenCalledTimes( 2 );

            timer.destroy();
        });

        test( 'should update existing active timer deadline on set()', () =>
        {
            vi.setSystemTime( 0 );

            const timer = new Timer();
            const cb = vi.fn();

            timer.set( 'updateTask', 500, cb );
            timer.set( 'updateTask', 800, cb ); // updates the existing active task

            vi.advanceTimersByTime( 600 );
            expect( cb ).not.toHaveBeenCalled();

            vi.advanceTimersByTime( 200 );
            expect( cb ).toHaveBeenCalledTimes( 1 );

            timer.destroy();
        });

        test( 'should return false on pause/resume if task not found or already in target state', () =>
        {
            const timer = new Timer();

            expect( timer.pause( 'nonexistent' ) ).toBe( false );
            expect( timer.resume( 'nonexistent' ) ).toBe( false );

            timer.set( 'task', 500, vi.fn() );
            expect( timer.resume( 'task' ) ).toBe( false ); // already running
            timer.pause( 'task' );
            expect( timer.pause( 'task' ) ).toBe( false ); // already paused

            timer.destroy();
        });

        test( 'should calculate next cron date in timezone with DOM and DOW restrictions', () =>
        {
            const baseDate = new Date( '2026-06-20T12:00:00Z' ); // 2026-06-20 is Saturday
            // 1. DOW restriction: schedule only on Sunday (0) or Monday (1)
            const nextSun = getNextCronDate( '0 12 * * 0,1', baseDate, 'America/New_York' );
            expect( nextSun.getUTCDay() ).toBe( 0 ); // Sunday

            // 2. DOM restriction: schedule only on the 25th of the month
            const next25 = getNextCronDate( '0 12 25 * *', baseDate, 'America/New_York' );
            expect( next25.getUTCDate() ).toBe( 25 );
        });

        test( 'should union-match DOM and DOW restrictions in non-timezone cron', () =>
        {
            const baseDate = new Date( '2026-06-20T12:00:00Z' ); // June 20, 2026 is Saturday
            // Schedule on the 22nd (Monday) OR on any Wednesday (3)
            const next = getNextCronDate( '0 12 22 * 3', baseDate );
            expect( next.getUTCDate() ).toBe( 22 ); // June 22 matches DOM
        });

        test( 'should throw if no matching cron date is found within 5 years', () =>
        {
            const baseDate = new Date( '2026-06-20T12:00:00Z' );
            expect( () => getNextCronDate( '0 12 30 2 *', baseDate ) ).toThrowError( 'No matching execution date found within 5 years.' );
        });

        test( 'should accept Date object with offset in normalize()', () =>
        {
            vi.setSystemTime( 0 );
            const timer = new Timer();
            const cb = vi.fn();

            timer.set( 'dateTask', new Date( 1000 ), cb, { offset: 100 } );

            vi.advanceTimersByTime( 1099 );
            expect( cb ).not.toHaveBeenCalled();

            vi.advanceTimersByTime( 1 );
            expect( cb ).toHaveBeenCalledTimes( 1 );

            timer.destroy();
        });

        test( 'should fallback to toISOString when cloning custom date-like object throws in normalize()', () =>
        {
            vi.setSystemTime( new Date( '2026-06-20T11:59:59Z' ).getTime() );
            const timer = new Timer();
            const cb = vi.fn();

            const customDate = {
                constructor: null,
                toISOString: () => '2026-06-20T12:00:00Z'
            };

            timer.set( 'customDateTask', customDate as any, cb );

            vi.advanceTimersByTime( 999 );
            expect( cb ).not.toHaveBeenCalled();

            vi.advanceTimersByTime( 1 );
            expect( cb ).toHaveBeenCalledTimes( 1 );

            timer.destroy();
        });

        test( 'should not do retries or reschedule if timer is set again inside callback with different values', async () =>
        {
            vi.setSystemTime( 0 );

            const timer = new Timer();
            const cb = vi.fn( ( { id } ) =>
            {
                // Call set again inside the callback to reschedule (relative delay 700ms, absolute 1200ms)
                timer.set( id, 700, cb );
                return Promise.reject( new Error( 'Failing' ) );
            });

            // Set with retry policy and interval
            timer.set( 'task1', 500, cb, {
                interval : 1000,
                retry    : { attempts: 3, delay: 100 }
            });

            vi.advanceTimersByTime( 500 );
            expect( cb ).toHaveBeenCalledTimes( 1 );
            await Promise.resolve();
            await Promise.resolve();

            // Advance to 600 - under old code, it would have retried.
            // Under new code, it should NOT retry at 600.
            vi.advanceTimersByTime( 100 );
            expect( cb ).toHaveBeenCalledTimes( 1 );

            // Advance to 1200 - the new set deadline should trigger
            vi.advanceTimersByTime( 600 );
            expect( cb ).toHaveBeenCalledTimes( 2 );

            timer.destroy();
        });

        test( 'should correctly infer callback data type parameter from options.data', () =>
        {
            const timer = new Timer();

            interface CustomData
            {
                foo : string
                bar : number
            }

            const data: CustomData = { foo: 'hello', bar: 123 };

            timer.set( 'inferTask', 500, ( { id, data: ctxData } ) =>
            {
                const fooVal: string = ctxData.foo;
                const barVal: number = ctxData.bar;

                expect( id ).toBe( 'inferTask' );
                expect( fooVal ).toBe( 'hello' );
                expect( barVal ).toBe( 123 );
            }, { data } );

            vi.advanceTimersByTime( 500 );
            timer.destroy();
        });
    });
});

