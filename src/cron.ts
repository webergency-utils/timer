const MONTH_NAMES = [ 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec' ];
const DAY_NAMES = [ 'sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat' ];
const MAX_CRON_CACHE_SIZE = 1000;
const MAX_FORMATTER_CACHE_SIZE = 50;
const INT_RE = /^-?\d+$/;

type ParsedCron =
    {
        minutes         : Set<number>
        hours           : Set<number>
        months          : Set<number>
        isDOMRestricted : boolean
        isDOWRestricted : boolean
        isDOMMatch      : ( date: Date ) => boolean
        isDOWMatch      : ( date: Date ) => boolean
    };

const cronCache = new Map<string, ParsedCron>();

const formatters = new Map<string, Intl.DateTimeFormat>();

function parseStrictInt( str: string ): number
{
    return INT_RE.test( str ) ? parseInt( str, 10 ) : NaN;
}

function getFormatter( timeZone: string ): Intl.DateTimeFormat
{
    let f = formatters.get( timeZone );

    if( !f )
    {
        f = new Intl.DateTimeFormat( 'en-US',
            {
                timeZone,
                hourCycle : 'h23',
                year      : 'numeric',
                month     : 'numeric',
                day       : 'numeric',
                hour      : 'numeric',
                minute    : 'numeric',
                second    : 'numeric'
            });

        if( formatters.size >= MAX_FORMATTER_CACHE_SIZE )
        {
            formatters.delete( formatters.keys().next().value! );
        }

        formatters.set( timeZone, f );
    }

    return f;
}

export function validateTimeZone( timeZone: string )
{
    try
    {
        Intl.DateTimeFormat( undefined, { timeZone });
    }
    catch
    {
        throw new Error( 'Invalid timezone: ' + timeZone );
    }
}

function getTZParts( date: Date, timeZone: string ): Record<string, number>
{
    const formatter = getFormatter( timeZone );
    const parts = formatter.formatToParts( date );
    const dict: Record<string, number> = {};

    for( const p of parts )
    {
        if( p.type !== 'literal' )
        {
            dict[ p.type ] = parseInt( p.value, 10 );
        }
    }

    return dict;
}

function getTZOffset( date: Date, timeZone: string ): number
{
    const dict = getTZParts( date, timeZone );
    const utc = Date.UTC( dict.year, dict.month - 1, dict.day, dict.hour, dict.minute, dict.second );

    return date.getTime() - utc;
}

function createTZDate( year: number, month: number, day: number, hour: number, minute: number, timeZone: string ): Date
{
    const utcEstimate = new Date( Date.UTC( year, month - 1, day, hour, minute ));
    const offset = getTZOffset( utcEstimate, timeZone );
    const result = new Date( utcEstimate.getTime() + offset );
    const actualOffset = getTZOffset( result, timeZone );

    if( actualOffset !== offset )
    {
        return new Date( utcEstimate.getTime() + actualOffset );
    }

    return result;
}

function stepTZDate( prev: Date, year: number, month: number, day: number, hour: number, minute: number, timeZone: string, fallbackMs: number ): Date
{
    const next = createTZDate( year, month, day, hour, minute, timeZone );

    return next.getTime() > prev.getTime() ? next : new Date(( Math.floor( prev.getTime() / 60000 ) * 60000 ) + fallbackMs );
}

type TZDateInfo =
    {
        year    : number
        month   : number
        day     : number
        hour    : number
        minute  : number
        weekday : number
    };

function getTZDateInfo( date: Date, timeZone: string ): TZDateInfo
{
    const dict = getTZParts( date, timeZone );
    const weekday = new Date( dict.year, dict.month - 1, dict.day ).getDay();

    return {
        year    : dict.year,
        month   : dict.month,
        day     : dict.day,
        hour    : dict.hour,
        minute  : dict.minute,
        weekday : weekday
    };
}

function normalizeMonthField( part: string ): string
{
    let p = part.toLowerCase();

    for( let i = 0; i < 12; i++ )
    {
        p = p.replace( new RegExp( MONTH_NAMES[ i ], 'g' ), String( i + 1 ));
    }

    return p;
}

function normalizeDOWField( part: string ): string
{
    let p = part.toLowerCase().replace( /-sun\b/g, '-7' );

    for( let i = 0; i < 7; i++ )
    {
        p = p.replace( new RegExp( DAY_NAMES[ i ], 'g' ), String( i ));
    }

    return p;
}

function parseCronField( field: string, min: number, max: number ): Set<number>
{
    const values = new Set<number>();
    const parts = field.split( ',' );

    for( const part of parts )
    {
        if( part === '*' || part === '?' )
        {
            for( let i = min; i <= max; i++ )
            {
                values.add( i );
            }
        }
        else if( part.includes( '/' ))
        {
            const stepParts = part.split( '/' );
            const step = stepParts.length === 2 ? parseStrictInt( stepParts[ 1 ]) : NaN;

            if( isNaN( step ) || step <= 0 )
            {
                throw new Error( 'Invalid step value.' );
            }

            const range = stepParts[ 0 ];
            let start = min;
            let end = max;

            if( range !== '*' && range !== '?' )
            {
                if( range.includes( '-' ))
                {
                    const rangeParts = range.split( '-' );

                    if( rangeParts.length !== 2 )
                    {
                        throw new Error( 'Invalid range syntax for step.' );
                    }

                    const s = parseStrictInt( rangeParts[ 0 ]);
                    const e = parseStrictInt( rangeParts[ 1 ]);

                    if( isNaN( s ) || isNaN( e ) || s < min || e > max || s > e )
                    {
                        throw new Error( 'Invalid range for step.' );
                    }

                    start = s;
                    end = e;
                }
                else
                {
                    const s = parseStrictInt( range );

                    if( isNaN( s ) || s < min || s > max )
                    {
                        throw new Error( 'Invalid start value for step.' );
                    }

                    start = s;
                }
            }

            for( let i = start; i <= end; i += step )
            {
                values.add( i );
            }
        }
        else if( part.includes( '-' ))
        {
            const rangeParts = part.split( '-' );

            if( rangeParts.length !== 2 )
            {
                throw new Error( 'Invalid range syntax.' );
            }

            const start = parseStrictInt( rangeParts[ 0 ]);
            const end = parseStrictInt( rangeParts[ 1 ]);

            if( isNaN( start ) || isNaN( end ) || start < min || end > max || start > end )
            {
                throw new Error( 'Invalid range.' );
            }

            for( let i = start; i <= end; i++ )
            {
                values.add( i );
            }
        }
        else
        {
            const val = parseStrictInt( part );

            if( isNaN( val ) || val < min || val > max )
            {
                throw new Error( 'Value out of bounds.' );
            }

            values.add( val );
        }
    }

    return values;
}

function getNearestWeekday( year: number, month: number, targetDay: number ): number
{
    const totalDays = new Date( year, month + 1, 0 ).getDate();
    const day = Math.min( targetDay, totalDays );
    const d = new Date( year, month, day );
    const dayOfWeek = d.getDay();

    if( dayOfWeek === 6 )
    {
        if( day === 1 ){ return 3 }

        return day - 1;
    }
    else if( dayOfWeek === 0 )
    {
        if( day === totalDays ){ return day - 2 }

        return day + 1;
    }

    return day;
}

function parseDOMItem( item: string ): ( date: Date ) => boolean
{
    const lower = item.toLowerCase();

    if( lower === '*' || lower === '?' )
    {
        return () => true;
    }

    if( lower === 'l' )
    {
        return ( date ) =>
        {
            const lastDay = new Date( date.getFullYear(), date.getMonth() + 1, 0 ).getDate();

            return date.getDate() === lastDay;
        };
    }

    if( lower === 'lw' || lower === 'l-w' )
    {
        return ( date ) =>
        {
            const lastDayDate = new Date( date.getFullYear(), date.getMonth() + 1, 0 );
            let target = lastDayDate.getDate();
            const dayOfWeek = lastDayDate.getDay();

            if( dayOfWeek === 6 ){ target -= 1 }
            else if( dayOfWeek === 0 ){ target -= 2 }

            return date.getDate() === target;
        };
    }

    if( lower.endsWith( 'w' ))
    {
        const targetDay = parseStrictInt( lower.slice( 0, -1 ));

        if( isNaN( targetDay ) || targetDay < 1 || targetDay > 31 )
        {
            throw new Error( 'Invalid nearest weekday value.' );
        }

        return ( date ) =>
        {
            return date.getDate() === getNearestWeekday( date.getFullYear(), date.getMonth(), targetDay );
        };
    }

    const values = parseCronField( lower, 1, 31 );

    return ( date ) => values.has( date.getDate());
}

function parseDOWItem( item: string ): ( date: Date ) => boolean
{
    const lower = item.toLowerCase();

    if( lower === '*' || lower === '?' )
    {
        return () => true;
    }

    if( lower.endsWith( 'l' ))
    {
        const dayVal = parseStrictInt( lower.slice( 0, -1 ));

        if( isNaN( dayVal ) || dayVal < 0 || dayVal > 7 )
        {
            throw new Error( 'Invalid last weekday of month value.' );
        }

        const targetDay = dayVal === 7 ? 0 : dayVal;

        return ( date ) =>
        {
            if( date.getDay() !== targetDay ){ return false }

            const totalDays = new Date( date.getFullYear(), date.getMonth() + 1, 0 ).getDate();

            return date.getDate() + 7 > totalDays;
        };
    }

    if( lower.includes( '#' ))
    {
        const hashParts = lower.split( '#' );
        const dayVal = hashParts.length === 2 ? parseStrictInt( hashParts[ 0 ]) : NaN;
        const targetOccurrence = hashParts.length === 2 ? parseStrictInt( hashParts[ 1 ]) : NaN;

        if( isNaN( dayVal ) || dayVal < 0 || dayVal > 7 || isNaN( targetOccurrence ) || targetOccurrence < 1 || targetOccurrence > 5 )
        {
            throw new Error( 'Invalid nth weekday of month value.' );
        }

        const targetDay = dayVal === 7 ? 0 : dayVal;

        return ( date ) =>
        {
            if( date.getDay() !== targetDay ){ return false }

            const occurrence = Math.floor(( date.getDate() - 1 ) / 7 ) + 1;

            return occurrence === targetOccurrence;
        };
    }

    const rawValues = parseCronField( lower, 0, 7 );
    const values = new Set<number>();

    for( const val of rawValues )
    {
        values.add( val === 7 ? 0 : val );
    }

    return ( date ) => values.has( date.getDay());
}

export function getNextCronDate( cron: string, fromDate: Date = new Date(), timeZone?: string ): Date
{
    if( timeZone )
    {
        validateTimeZone( timeZone );
    }

    const cacheKey = cron.trim().replace( /\s+/g, ' ' );
    let parsed = cronCache.get( cacheKey );

    if( !parsed )
    {
        const fields = cacheKey.split( ' ' );

        if( fields.length !== 5 )
        {
            throw new Error( 'Invalid cron expression. Only 5-field expressions are supported.' );
        }

        const minutes = parseCronField( fields[ 0 ], 0, 59 );
        const hours = parseCronField( fields[ 1 ], 0, 23 );
        const months = parseCronField( normalizeMonthField( fields[ 3 ]), 1, 12 );

        const domParts = fields[ 2 ].split( ',' );
        const domMatchers = domParts.map( parseDOMItem );
        const isDOMRestricted = fields[ 2 ] !== '*' && fields[ 2 ] !== '?';
        const isDOMMatch = ( date: Date ) => domMatchers.some( m => m( date ));

        const dowParts = normalizeDOWField( fields[ 4 ]).split( ',' );
        const dowMatchers = dowParts.map( parseDOWItem );
        const isDOWRestricted = fields[ 4 ] !== '*' && fields[ 4 ] !== '?';
        const isDOWMatch = ( date: Date ) => dowMatchers.some( m => m( date ));

        if( cronCache.size >= MAX_CRON_CACHE_SIZE )
        {
            cronCache.delete( cronCache.keys().next().value! );
        }

        cronCache.set( cacheKey, parsed = { minutes, hours, months, isDOMRestricted, isDOWRestricted, isDOMMatch, isDOWMatch });
    }

    const { minutes, hours, months, isDOMRestricted, isDOWRestricted, isDOMMatch, isDOWMatch } = parsed;

    if( timeZone )
    {
        const infoStart = getTZDateInfo( fromDate, timeZone );
        let current = stepTZDate( fromDate, infoStart.year, infoStart.month, infoStart.day, infoStart.hour, infoStart.minute + 1, timeZone, 60000 );
        const limit = new Date( current.getTime());
        limit.setFullYear( limit.getFullYear() + 5 );

        while( current.getTime() < limit.getTime())
        {
            const info = getTZDateInfo( current, timeZone );

            if( !months.has( info.month ))
            {
                current = createTZDate( info.year, info.month + 1, 1, 0, 0, timeZone );

                continue;
            }

            const localEquivalent = new Date( info.year, info.month - 1, info.day, info.hour, info.minute );

            if( isDOMRestricted && isDOWRestricted )
            {
                if( !isDOMMatch( localEquivalent ) && !isDOWMatch( localEquivalent ))
                {
                    current = createTZDate( info.year, info.month, info.day + 1, 0, 0, timeZone );

                    continue;
                }
            }
            else
            {
                if( isDOMRestricted && !isDOMMatch( localEquivalent ))
                {
                    current = createTZDate( info.year, info.month, info.day + 1, 0, 0, timeZone );

                    continue;
                }

                if( isDOWRestricted && !isDOWMatch( localEquivalent ))
                {
                    current = createTZDate( info.year, info.month, info.day + 1, 0, 0, timeZone );

                    continue;
                }
            }

            if( !hours.has( info.hour ))
            {
                current = stepTZDate( current, info.year, info.month, info.day, info.hour + 1, 0, timeZone, ( 60 - info.minute ) * 60000 );

                continue;
            }

            if( !minutes.has( info.minute ))
            {
                current = new Date( current.getTime() + 60000 );

                continue;
            }

            return current;
        }
    }
    else
    {
        const current = new Date(( Math.floor( fromDate.getTime() / 60000 ) + 1 ) * 60000 );
        const limit = new Date( current.getTime());
        limit.setFullYear( limit.getFullYear() + 5 );

        while( current.getTime() < limit.getTime())
        {
            const month = current.getMonth() + 1;

            if( !months.has( month ))
            {
                current.setMonth( current.getMonth() + 1, 1 );
                current.setHours( 0, 0, 0, 0 );

                continue;
            }

            if( isDOMRestricted && isDOWRestricted )
            {
                if( !isDOMMatch( current ) && !isDOWMatch( current ))
                {
                    current.setDate( current.getDate() + 1 );
                    current.setHours( 0, 0, 0, 0 );

                    continue;
                }
            }
            else
            {
                if( isDOMRestricted && !isDOMMatch( current ))
                {
                    current.setDate( current.getDate() + 1 );
                    current.setHours( 0, 0, 0, 0 );

                    continue;
                }

                if( isDOWRestricted && !isDOWMatch( current ))
                {
                    current.setDate( current.getDate() + 1 );
                    current.setHours( 0, 0, 0, 0 );

                    continue;
                }
            }

            const hour = current.getHours();

            if( !hours.has( hour ))
            {
                current.setTime( current.getTime() + (( 60 - current.getMinutes()) * 60000 ));

                continue;
            }

            const minute = current.getMinutes();

            if( !minutes.has( minute ))
            {
                current.setTime( current.getTime() + 60000 );

                continue;
            }

            return current;
        }
    }

    throw new Error( 'No matching execution date found within 5 years.' );
}
