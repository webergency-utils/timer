import Heap from '@webergency-utils/heap';
import { getNextCronDate, validateTimeZone } from './cron';
import type { RetryOptions, TimerOptions, TimerConstructorOptions, TimerEntry, TimerCallback } from './types';

export type { RetryOptions, TimerOptions, TimerConstructorOptions, TimerCallback };

const MAX_TIMEOUT_MS = 365 * 24 * 60 * 60 * 1000;

const normalize = ( time: Date | number, offset: number = 0 ) =>
{
    const validOffset = ( typeof offset === 'number' && Number.isFinite( offset )) ? offset : 0;

    if( typeof time === 'number' )
    {
        if( !Number.isFinite( time ))
        {
            throw new Error( 'Invalid deadline.' );
        }

        return ( time < MAX_TIMEOUT_MS ? Date.now() + time : time ) + validOffset;
    }

    if( !time || typeof time !== 'object' )
    {
        throw new Error( 'Invalid deadline.' );
    }

    let ms: number;

    if( typeof time.getTime === 'function' )
    {
        ms = time.getTime();
    }
    else if( typeof time.toISOString === 'function' )
    {
        ms = new Date( time.toISOString()).getTime();
    }
    else
    {
        throw new Error( 'Invalid deadline.' );
    }

    if( !Number.isFinite( ms ))
    {
        throw new Error( 'Invalid deadline.' );
    }

    return ms + validOffset;
};

let globallyPaused = false;

export default class Timer
{
    /* STATIC */

    static #timers = new Set<Timer>();
    static #idCounter = Math.floor( Math.random() * 65536 );

    public static id( prefix: string = '' ): string
    {
        Timer.#idCounter = ( Timer.#idCounter + 1 ) & 0xFFFF;

        return prefix + (( Date.now() % 137438953472 ) * 65536 + Timer.#idCounter );
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

    #name : string | undefined;

    public get name()
    {
        return this.#name;
    }
    #paused            : boolean = false;
    #timeout           : ReturnType<typeof setTimeout> | undefined;
    #scheduledDeadline : number | undefined;
    #index = new Map<string, TimerEntry>();
    #heap = new Heap<TimerEntry, string>(( a, b ) => a.deadline - b.deadline, i => i.id );
    #defaultTimezone   : string | undefined;
    #defaultRetry      : RetryOptions | undefined;

    public constructor( options?: TimerConstructorOptions );
    public constructor( name?: string, options?: TimerConstructorOptions );
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
        this.#defaultRetry = opts?.retry ? { ...opts.retry } : undefined;

        if( this.#defaultTimezone !== undefined )
        {
            validateTimeZone( this.#defaultTimezone );
        }

        Timer.#timers.add( this );
    }

    #schedule()
    {
        const top = this.#heap.top();

        if( this.#paused || globallyPaused || !top )
        {
            if( this.#timeout )
            {
                clearTimeout( this.#timeout );
                this.#timeout = undefined;
                this.#scheduledDeadline = undefined;
            }

            return;
        }

        const now = Date.now();
        const target = Math.max( now, Math.min( now + 60000, top.deadline ));

        if( this.#timeout && this.#scheduledDeadline === target )
        {
            return;
        }

        this.#timeout && clearTimeout( this.#timeout );
        this.#scheduledDeadline = target;
        this.#timeout = setTimeout(() => this.#dispatch(), target - now );
    }

    #reschedule( timer: TimerEntry, startTime: number, startVersion: number, endTime: number, isAsync: boolean, failed: boolean )
    {
        const currentTimer = this.#index.get( timer.id );

        if( currentTimer === timer && currentTimer.version === startVersion )
        {
            timer.inFlight = false;

            if( failed && timer.retry && ( timer.retry.attempts ?? 0 ) > 0 )
            {
                if( !timer.retryAttempt )
                {
                    let nextRegular: number | undefined;

                    if( timer.cron )
                    {
                        try
                        {
                            nextRegular = getNextCronDate( timer.cron, new Date( Math.max( endTime, startTime )), timer.timezone ).getTime();
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
                            nextRegular = startTime + Math.ceil( Math.max( 1, ( endTime - startTime ) / timer.interval )) * timer.interval;
                        }
                    }

                    timer.nextRegularFiring = nextRegular;
                }

                const attempt = timer.retryAttempt! + 1;

                if( attempt <= timer.retry.attempts! )
                {
                    const rawDelay = timer.retry.delay;
                    const baseDelay = ( rawDelay !== undefined && Number.isFinite( rawDelay ) && rawDelay >= 0 ) ? rawDelay : 1000;
                    const multiplier = timer.retry.backoff === 'exponential' ? Math.pow( 2, Math.min( attempt - 1, 30 )) : 1;
                    const retryDelay = Math.min( MAX_TIMEOUT_MS, baseDelay * multiplier );
                    const jitter = retryDelay * ( Math.random() * 0.2 - 0.1 );
                    const retryDeadline = Date.now() + Math.max( 1, Math.round( retryDelay + jitter ));

                    if( timer.nextRegularFiring !== undefined && retryDeadline >= timer.nextRegularFiring )
                    {
                        timer.deadline = timer.nextRegularFiring;
                        timer.retryAttempt = 0;
                        timer.nextRegularFiring = undefined;
                    }
                    else
                    {
                        timer.deadline = retryDeadline;
                        timer.retryAttempt = attempt;
                    }

                    if( timer.expires !== undefined && timer.deadline > timer.expires )
                    {
                        this.#index.delete( timer.id );

                        return;
                    }

                    !timer.paused && this.#heap.push( timer );
                    isAsync && this.#schedule();

                    return;
                }
            }

            timer.retryAttempt = 0;
            timer.nextRegularFiring = undefined;

            let nextDeadline: number;

            if( timer.cron )
            {
                try
                {
                    nextDeadline = getNextCronDate( timer.cron, new Date( Math.max( endTime, startTime )), timer.timezone ).getTime();
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
                    nextDeadline = startTime + Math.ceil( Math.max( 1, ( endTime - startTime ) / timer.interval )) * timer.interval;
                }
            }
            else
            {
                this.#index.delete( timer.id );

                return;
            }

            if( timer.expires !== undefined && nextDeadline > timer.expires )
            {
                this.#index.delete( timer.id );

                return;
            }

            timer.deadline = nextDeadline;
            !timer.paused && this.#heap.push( timer );
            isAsync && this.#schedule();
        }
    }

    #dispatch()
    {
        this.#timeout = undefined;
        this.#scheduledDeadline = undefined;

        let top;
        const now = Date.now();

        while( !( this.#paused || globallyPaused ) && ( top = this.#heap.top()) && ( top.deadline <= now ))
        {
            const timer = this.#heap.pop()!;
            const startTime = timer.deadline;
            const startVersion = timer.version!;

            if( timer.expires !== undefined && timer.expires < now - 100 )
            {
                this.#index.delete( timer.id );

                continue;
            }

            timer.inFlight = true;

            let result: any = null;
            let threwSync = false;

            try
            {
                result = timer.callback({ id : timer.id, data : timer.data });
            }
            catch( e )
            {
                threwSync = true;
            }

            if( !threwSync && result && typeof ( result as any ).then === 'function' )
            {
                ( result as any ).then(
                    () => this.#reschedule( timer, startTime, startVersion, Date.now(), true, false ),
                    () => this.#reschedule( timer, startTime, startVersion, Date.now(), true, true )
                );
            }
            else
            {
                this.#reschedule( timer, startTime, startVersion, Date.now(), false, threwSync );
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
        return Array.from( this.#index.keys());
    }

    public set<Data = any>( id: string, deadline: Date | number | string, callback: TimerCallback<Data>, options: TimerOptions<Data> = {})
    {
        if( typeof deadline === 'string' && options.interval !== undefined )
        {
            throw new Error( 'Cron timers cannot have an interval option.' );
        }

        if( options.expires !== undefined )
        {
            if( typeof options.expires === 'number' && ( !Number.isFinite( options.expires ) || options.expires <= MAX_TIMEOUT_MS ))
            {
                throw new Error( 'Expiry time must be an absolute timestamp or Date.' );
            }
        }

        let timer = this.#index.get( id );
        const expires = options.expires !== undefined ? normalize( options.expires ) : undefined;

        if( expires !== undefined && expires < Date.now())
        {
            if( timer )
            {
                this.unset( id );
            }

            return;
        }

        const timezone = options.timezone !== undefined ? options.timezone : this.#defaultTimezone;
        const interval = ( typeof options.interval === 'number' && Number.isFinite( options.interval ) && options.interval > 0 ) ? options.interval : undefined;
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
            timer.version = timer.version! + 1;
            timer.inFlight = false;
            timer.deadline = actualDeadline;
            timer.expires = expires;
            timer.callback = callback;
            timer.data = options.data;
            timer.cron = cronExpr;
            timer.interval = interval;
            timer.retry = retry;
            timer.retryAttempt = 0;
            timer.nextRegularFiring = undefined;
            timer.timezone = timezone;

            if( timer.paused || !this.#heap.has( id ))
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
            this.#index.set( id, timer = { id, deadline : actualDeadline, expires, callback, data : options.data, cron : cronExpr, interval, retry, retryAttempt : 0, nextRegularFiring : undefined, timezone, inFlight : false, version : 1 });
            this.#heap.push( timer );
        }

        this.#schedule();
    }

    public postpone( id: string, deadline: Date | number, options: Omit<TimerOptions, 'data' | 'interval'> = {}): boolean
    {
        const timer = this.#index.get( id );

        if( !timer ){ return false }

        if( options.expires !== undefined )
        {
            if( typeof options.expires === 'number' && ( !Number.isFinite( options.expires ) || options.expires <= MAX_TIMEOUT_MS ))
            {
                throw new Error( 'Expiry time must be an absolute timestamp or Date.' );
            }
        }

        if( options.timezone )
        {
            validateTimeZone( options.timezone );
        }

        const newDeadline = normalize( deadline, options.offset );
        const expires = options.expires !== undefined ? normalize( options.expires ) : timer.expires;

        if( expires !== undefined && expires < Date.now())
        {
            this.unset( id );

            return false;
        }

        timer.version = timer.version! + 1;
        timer.inFlight = false;
        timer.deadline = newDeadline;
        timer.expires = expires;
        timer.retryAttempt = 0;
        timer.nextRegularFiring = undefined;

        if( options.timezone !== undefined )
        {
            timer.timezone = options.timezone;
        }

        if( options.retry !== undefined )
        {
            timer.retry = options.retry ? { ...options.retry } : undefined;
        }

        if( !timer.paused )
        {
            if( !this.#heap.has( timer.id ))
            {
                this.#heap.push( timer );
            }
            else
            {
                this.#heap.update( timer );
            }
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

            if( !timer.inFlight )
            {
                this.#heap.push( timer );
                this.#schedule();
            }

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
