import { describe, test, expect, vi } from 'vitest';
import Timer from '../timer';
import { getNextCronDate } from '../cron';

describe( 'Timer tests without fake timers (real environment)', () =>
{
    test( 'should verify name getter and Date constructor check in normalize', () =>
    {
        const name = 'real-time-timer';
        const timer = new Timer( name );

        expect( timer.name ).toBe( name );

        const cb = vi.fn();
        // Passing a standard Date object without options.offset
        // This will trigger `time.constructor === Date` check inside normalize()
        timer.set( 'realDateTask', new Date( Date.now() + 10000 ), cb );

        expect( timer.has( 'realDateTask' ) ).toBe( true );

        timer.destroy();
    });

    describe( 'Additional Cron branch tests', () =>
    {
        test( 'should parse cron field step with single start value (e.g., 5/2)', () =>
        {
            const baseDate = new Date( '2026-06-20T12:00:00Z' );
            const next = getNextCronDate( '5/2 12 * * *', baseDate );

            // Starts at minute 5, then 7, 9...
            expect( next.getUTCMinutes() ).toBe( 5 );
        });

        test( 'should throw error on invalid range (start > end)', () =>
        {
            const baseDate = new Date( '2026-06-20T12:00:00Z' );
            expect( () => getNextCronDate( '0 12 10-5 * *', baseDate ) ).toThrowError( 'Invalid range.' );
        });

        test( 'should handle nearest weekday 1W when the 1st is a Saturday (returns Monday 3rd)', () =>
        {
            // August 1, 2026 is Saturday. Nearest weekday should be August 3 (Monday).
            const baseDate = new Date( '2026-08-01T00:00:00Z' );
            const next = getNextCronDate( '0 12 1W * *', baseDate );

            expect( next.getUTCDate() ).toBe( 3 );
        });

        test( 'should handle nearest weekday 15W when 15th is Saturday (returns Friday 14th)', () =>
        {
            // August 15, 2026 is Saturday. Nearest weekday should be August 14 (Friday).
            const baseDate = new Date( '2026-08-01T00:00:00Z' );
            const next = getNextCronDate( '0 12 15W * *', baseDate );

            expect( next.getUTCDate() ).toBe( 14 );
        });

        test( 'should handle nearest weekday 15W when 15th is already a weekday (returns 15th)', () =>
        {
            // June 15, 2026 is Monday. Nearest weekday should be June 15.
            const baseDate = new Date( '2026-06-01T00:00:00Z' );
            const next = getNextCronDate( '0 12 15W * *', baseDate );

            expect( next.getUTCDate() ).toBe( 15 );
        });

        test( 'should handle last weekday of month LW when last day is Sunday (returns Friday 29th)', () =>
        {
            // May 31, 2026 is Sunday. Last weekday should be May 29 (Friday).
            const baseDate = new Date( '2026-05-01T00:00:00Z' );
            const next = getNextCronDate( '0 12 LW * *', baseDate );

            expect( next.getUTCDate() ).toBe( 29 );
        });

        test( 'should throw on invalid step values', () =>
        {
            const baseDate = new Date();
            expect( () => getNextCronDate( '*/0 * * * *', baseDate ) ).toThrowError( 'Invalid step value.' );
            expect( () => getNextCronDate( '*/-5 * * * *', baseDate ) ).toThrowError( 'Invalid step value.' );
        });

        test( 'should throw on invalid range syntax for step', () =>
        {
            const baseDate = new Date();
            expect( () => getNextCronDate( '1-2-3/2 * * * *', baseDate ) ).toThrowError( 'Invalid range syntax for step.' );
        });

        test( 'should throw on invalid range boundaries for step', () =>
        {
            const baseDate = new Date();
            expect( () => getNextCronDate( '10-5/2 * * * *', baseDate ) ).toThrowError( 'Invalid range for step.' );
        });

        test( 'should throw on invalid start value for step', () =>
        {
            const baseDate = new Date();
            expect( () => getNextCronDate( '65/2 * * * *', baseDate ) ).toThrowError( 'Invalid start value for step.' );
        });

        test( 'should handle DST transition offset difference in America/New_York', () =>
        {
            // March 8, 2026 is the DST start date in America/New_York.
            // Clocks skip 02:00-03:00. Starting at 04:00 AM EDT (08:00:00Z) and checking 05:00 AM triggers transition logic.
            const baseDate = new Date( '2026-03-08T08:00:00Z' );
            const next = getNextCronDate( '0 5 8 3 *', baseDate, 'America/New_York' );

            expect( next ).toBeInstanceOf( Date );
            expect( next.getUTCHours() ).toBe( 9 ); // 5:00 AM EDT is 9:00 AM UTC
        });
    });
});
