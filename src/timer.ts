import Heap from '@webergency-utils/heap';
import { getNextCronDate, validateTimeZone } from './cron';
import type { RetryOptions, TimerOptions, TimerConstructorOptions, TimerEntry, TimerCallback } from './types';

export type { RetryOptions, TimerOptions, TimerConstructorOptions, TimerCallback };

const MAX_TIMEOUT_MS = 365 * 24 * 60 * 60 * 1000;

const normalize = ( time: Date | number, offset: number = 0 ) =>
{
    if( typeof time === 'number' )
    {
        return ( time < MAX_TIMEOUT_MS ? Date.now() + time : time ) + offset;
    }

    let clone: Date;

    if( time.constructor === Date )
    {
        clone = new Date( time.getTime() );
    }
    else
    {
        try
        {
            clone = new ( time.constructor as any )( time ) as Date;
        }
        catch( e )
        {
            clone = new Date( time.toISOString() );
        }
    }

    if( offset )
    {
        clone.setMilliseconds( clone.getMilliseconds() + offset );
    }

    return clone.getTime();
};

let globallyPaused = false;

export default class Timer
{
    /* STATIC */

    static #timers = new Set<Timer>();

    public static id( prefix: string = '' ): string
    {
        return prefix + ( ( Date.now() % 137438953472 ) * 65536 + Math.floor( Math.random() * 65536 ) );
    }

    public static pause()
    {
        globallyPaused = true;

        for( const timer of Timer.#timers )
        {
            timer.#schedule();
        }
    }

    public static resume()
    {
        globallyPaused = false;

        for( const timer of Timer.#timers )
        {
            timer.#schedule();
        }
    }

    /* INSTANCE */

    #name: string | undefined;

    public get name()
    {
        return this.#name;
    }
    #paused: boolean = false;
    #timeout: ReturnType<typeof setTimeout> | undefined;
    #index = new Map<string, TimerEntry>();
    #heap = new Heap<TimerEntry, string>( ( a, b ) => a.deadline - b.deadline, i => i.id );
    #defaultTimezone: string | undefined;
    #defaultRetry: RetryOptions | undefined;

    public constructor( options?: TimerConstructorOptions )
    public constructor( name?: string, options?: TimerConstructorOptions )
    public constructor( nameOrOptions?: string | TimerConstructorOptions, options?: TimerConstructorOptions )
    {
        let name: string | undefined;
        let opts: TimerConstructorOptions | undefined;

        if( typeof nameOrOptions === 'string' )
        {
            name = nameOrOptions;
            opts = options;
        }
        else if( nameOrOptions && typeof nameOrOptions === 'object' )
        {
            opts = nameOrOptions;
        }

        this.#name = name;
        this.#defaultTimezone = opts?.timezone;
        this.#defaultRetry = opts?.retry;

        if( this.#defaultTimezone !== undefined )
        {
            validateTimeZone( this.#defaultTimezone );
        }

        Timer.#timers.add( this );
    }

    #schedule()
    {
        this.#timeout && clearTimeout( this.#timeout );

        this.#timeout = !( this.#paused || globallyPaused ) && this.#heap.top() ? setTimeout( () => this.#dispatch(), Math.max( 0, Math.min( 60000, this.#heap.top()!.deadline - Date.now() ) ) ) : undefined;
    }

    #dispatch()
    {
        this.#timeout = undefined;

        let top, now = Date.now();

        while( ( top = this.#heap.top() ) && ( top.deadline <= now + 16 ) )
        {
            let timer = this.#heap.pop()!;
            const startTime = timer.deadline;
            const startVersion = timer.version ?? 0;

            let result: any = null;
            let threwSync = false;
            let syncError: any = null;

            const shouldExecute = !timer.expires || timer.expires >= now - 100;

            if( shouldExecute )
            {
                try
                {
                    result = timer.callback( { id: timer.id, data: timer.data } );
                }
                catch( e )
                {
                    threwSync = true;
                    syncError = e;
                }
            }

            const handleReschedule = ( endTime: number, isAsync: boolean, error: any ) =>
            {
                const currentTimer = this.#index.get( timer.id );

                if( currentTimer === timer && ( currentTimer.version ?? 0 ) === startVersion )
                {
                    if( error && timer.retry && ( timer.retry.attempts ?? 0 ) > 0 )
                    {
                        if( !timer.retryAttempt )
                        {
                            let nextRegular: number | undefined;

                            if( timer.cron )
                            {
                                try
                                {
                                    nextRegular = getNextCronDate( timer.cron, new Date( Math.max( endTime, startTime ) ), timer.timezone ).getTime();
                                }
                                catch( e )
                                {
                                    // If cron parse fails, we leave nextRegular as undefined
                                }
                            }
                            else if( timer.interval )
                            {
                                if( isAsync )
                                {
                                    nextRegular = endTime + timer.interval;
                                }
                                else
                                {
                                    nextRegular = startTime + Math.ceil( Math.max( 1, ( endTime - startTime ) / timer.interval ) ) * timer.interval;
                                }
                            }

                            timer.nextRegularFiring = nextRegular;
                        }

                        const attempt = ( timer.retryAttempt ?? 0 ) + 1;

                        if( attempt <= ( timer.retry.attempts ?? 0 ) )
                        {
                            timer.retryAttempt = attempt;
                            const baseDelay = timer.retry.delay ?? 1000;
                            const multiplier = timer.retry.backoff === 'exponential' ? Math.pow( 2, attempt - 1 ) : 1;
                            const retryDelay = baseDelay * multiplier;
                            const jitter = retryDelay * ( Math.random() * 0.2 - 0.1 );
                            const retryDeadline = Date.now() + Math.round( retryDelay + jitter );

                            if( timer.nextRegularFiring !== undefined && retryDeadline >= timer.nextRegularFiring )
                            {
                                timer.deadline = timer.nextRegularFiring;
                                timer.retryAttempt = 0;
                                timer.nextRegularFiring = undefined;
                                this.#heap.push( timer );
                                this.#schedule();

                                return;
                            }

                            timer.deadline = retryDeadline;
                            this.#heap.push( timer );
                            this.#schedule();

                            return;
                        }
                    }

                    timer.retryAttempt = 0;
                    timer.nextRegularFiring = undefined;

                    let nextDeadline: number;

                    if( timer.deadline > startTime )
                    {
                        nextDeadline = timer.deadline;
                    }
                    else if( timer.cron )
                    {
                        try
                        {
                            nextDeadline = getNextCronDate( timer.cron, new Date( Math.max( endTime, startTime ) ), timer.timezone ).getTime();
                        }
                        catch( e )
                        {
                            this.#index.delete( timer.id );

                            return;
                        }
                    }
                    else if( timer.interval )
                    {
                        if( isAsync )
                        {
                            nextDeadline = endTime + timer.interval;
                        }
                        else
                        {
                            nextDeadline = startTime + Math.ceil( Math.max( 1, ( endTime - startTime ) / timer.interval ) ) * timer.interval;
                        }
                    }
                    else
                    {
                        this.#index.delete( timer.id );

                        return;
                    }

                    timer.deadline = nextDeadline;
                    this.#heap.push( timer );
                    this.#schedule();
                }
            };

            if( !threwSync && result && typeof ( result as any ).then === 'function' )
            {
                ( result as any ).then(
                    () => handleReschedule( Date.now(), true, null ),
                    ( err: any ) => handleReschedule( Date.now(), true, err || new Error( 'Async execution failed' ) )
                );
            }
            else
            {
                handleReschedule( Date.now(), false, threwSync ? syncError : null );
            }
        }

        this.#schedule();
    }

    public id( prefix: string = '' ): string
    {
        return Timer.id( prefix );
    }

    public has( id: string ): boolean
    {
        return this.#index.has( id );
    }

    public ids(): string[]
    {
        return Array.from( this.#index.keys() );
    }

    public set<Data = any>( id: string, deadline: Date | number | string, callback: TimerCallback<Data>, options: TimerOptions<Data> = {} )
    {
        if( typeof deadline === 'string' && options.interval !== undefined )
        {
            throw new Error( 'Cron timers cannot have an interval option.' );
        }

        if( options.expires !== undefined )
        {
            if( typeof options.expires === 'number' && options.expires <= MAX_TIMEOUT_MS )
            {
                throw new Error( 'Expiry time must be an absolute timestamp or Date.' );
            }
        }

        let timer = this.#index.get( id ), expires = options.expires ? normalize( options.expires ) : undefined;

        if( expires !== undefined && expires < Date.now() )
        {
            if( timer )
            {
                this.unset( id );
            }

            return;
        }

        const timezone = options.timezone !== undefined ? options.timezone : this.#defaultTimezone;
        const retry = options.retry !== undefined
            ? ( options.retry ? { ...options.retry } : undefined )
            : ( this.#defaultRetry ? { ...this.#defaultRetry } : undefined );

        let actualDeadline: number;
        let cronExpr: string | undefined;

        if( typeof deadline === 'string' )
        {
            cronExpr = deadline;
            actualDeadline = getNextCronDate( deadline, new Date(), timezone ).getTime();
        }
        else
        {
            actualDeadline = normalize( deadline, options.offset );
        }

        if( timer )
        {
            timer.version = ( timer.version ?? 0 ) + 1;
            timer.deadline = actualDeadline;
            timer.expires = expires;
            timer.callback = callback;
            timer.data = options.data;
            timer.cron = cronExpr;
            timer.interval = options.interval;
            timer.retry = retry;
            timer.retryAttempt = 0;
            timer.nextRegularFiring = undefined;
            timer.timezone = timezone;

            if( timer.paused || !this.#heap.has( id ) )
            {
                timer.paused = false;
                this.#heap.push( timer );
            }
            else
            {
                this.#heap.update( timer );
            }
        }
        else
        {
            this.#index.set( id, timer = { id, deadline: actualDeadline, expires, callback, data: options.data, cron: cronExpr, interval: options.interval, retry, retryAttempt: 0, nextRegularFiring: undefined, timezone, version: 1 } );
            this.#heap.push( timer );
        }

        this.#schedule();
    }

    public postpone( id: string, deadline: Date | number, options: Omit<TimerOptions, 'data' | 'interval'> = {} ): boolean
    {
        const timer = this.#index.get( id );

        if( !timer ){ return false }

        if( options.expires !== undefined )
        {
            if( typeof options.expires === 'number' && options.expires <= MAX_TIMEOUT_MS )
            {
                throw new Error( 'Expiry time must be an absolute timestamp or Date.' );
            }
        }

        const expires = options.expires ? normalize( options.expires ) : timer.expires;

        if( expires !== undefined && expires < Date.now() )
        {
            this.unset( id );

            return false;
        }

        timer.version = ( timer.version ?? 0 ) + 1;
        timer.deadline = normalize( deadline, options.offset );
        timer.expires = expires;
        timer.retryAttempt = 0;
        timer.nextRegularFiring = undefined;

        if( timer.paused )
        {
            // Keep it paused, do not push to heap
        }
        else if( !this.#heap.has( timer.id ) )
        {
            this.#heap.push( timer );
        }
        else
        {
            this.#heap.update( timer );
        }

        this.#schedule();

        return true;
    }

    public unset( id: string ): boolean
    {
        const timer = this.#index.get( id );

        if( timer )
        {
            this.#index.delete( id );
            this.#heap.delete( timer );

            this.#schedule();
        }

        return !!timer;
    }

    public clear()
    {
        this.#index.clear();
        this.#heap.clear();

        this.#schedule();
    }

    public pause( id?: string ): boolean | void
    {
        if( id === undefined )
        {
            this.#paused = true;
            this.#schedule();

            return;
        }

        const timer = this.#index.get( id );

        if( timer && !timer.paused )
        {
            timer.paused = true;
            this.#heap.delete( timer );
            this.#schedule();

            return true;
        }

        return false;
    }

    public resume( id?: string ): boolean | void
    {
        if( id === undefined )
        {
            this.#paused = false;
            this.#schedule();

            return;
        }

        const timer = this.#index.get( id );

        if( timer && timer.paused )
        {
            timer.paused = false;
            this.#heap.push( timer );
            this.#schedule();

            return true;
        }

        return false;
    }

    public destroy()
    {
        this.clear();

        Timer.#timers.delete( this );
    }
}
