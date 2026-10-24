const MONTH_MAP: Record<string, string> =
    {
        jan : '1', feb : '2', mar : '3', apr : '4', may : '5', jun : '6',
        jul : '7', aug : '8', sep : '9', oct : '10', nov : '11', dec : '12'
    };
const DAY_MAP: Record<string, string> =
    {
        sun : '0', mon : '1', tue : '2', wed : '3', thu : '4', fri : '5', sat : '6'
    };
const MONTH_RE = /jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec/g;
const DAY_RE = /sun|mon|tue|wed|thu|fri|sat/g;
const ALPHA_RE = /[a-zA-Z]/;
const SPECIAL_DOM_RE = /[lw]/i;
const SPECIAL_DOW_RE = /[l#]/i;
const MULTI_SPACE_RE = /\s+/g;
const MAX_CRON_CACHE_SIZE = 1000;
const MAX_FORMATTER_CACHE_SIZE = 50;
const INT_RE = /^-?\d+$/;

type ParsedCron =
    {
        nextMinute      : Int8Array
        nextHour        : Int8Array
        nextMonth       : Int8Array
        isDOMRestricted : boolean
        isDOWRestricted : boolean
        isDOMMatch      : ( date: Date ) => boolean
        isDOWMatch      : ( date: Date ) => boolean
    };

type TZParts =
    {
        year   : number
        month  : number
        day    : number
        hour   : number
        minute : number
        second : number
    };

const cronCache = new Map<string, ParsedCron>();

const formatters = new Map<string, Intl.DateTimeFormat>();

function parseStrictInt( str: string ): number
{
    return INT_RE.test( str ) ? parseInt( str, 10 ) : NaN;
}

function buildNextLookup( set: Set<number>, size: number, min: number ): Int8Array
{
    const table = new Int8Array( size );
    let next = -1;

    for( let i = size - 1; i >= min; i-- )
    {
        if( set.has( i ))
        {
            next = i;
        }

        table[ i ] = next;
    }

    return table;
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
        getFormatter( timeZone );
    }
    catch
    {
        throw new Error( 'Invalid timezone: ' + timeZone );
    }
}

function getTZParts( date: Date, timeZone: string ): TZParts
{
    const formatter = getFormatter( timeZone );
    const parts = formatter.formatToParts( date );
    let year = 0;
    let month = 0;
    let day = 0;
    let hour = 0;
    let minute = 0;
    let second = 0;

    for( let i = 0; i < parts.length; i++ )
    {
        const p = parts[ i ];

        switch ( p.type )
        {
            case 'year': year = +p.value; break;
            case 'month': month = +p.value; break;
            case 'day': day = +p.value; break;
            case 'hour': hour = +p.value; break;
            case 'minute': minute = +p.value; break;
            case 'second': second = +p.value; break;
        }
    }

    return { year, month, day, hour, minute, second };
}

function getTZOffset( date: Date, timeZone: string ): number
{
    const dict = getTZParts( date, timeZone );
    const utc = Date.UTC( dict.year, dict.month - 1, dict.day, dict.hour, dict.minute, dict.second );

    return date.getTime() - utc;
}

function createTZDate( year: number, month: number, day: number, hour: number, minute: number, timeZone: string ): Date
{
    const utcMs = Date.UTC( year, month - 1, day, hour, minute );
    const utcEstimate = new Date( utcMs );
    const offset = getTZOffset( utcEstimate, timeZone );

    if( offset === 0 )
    {
        return utcEstimate;
    }

    const result = new Date( utcMs + offset );
    const actualOffset = getTZOffset( result, timeZone );

    if( actualOffset !== offset )
    {
        return new Date( utcMs + actualOffset );
    }

    return result;
}

function stepTZDate( prev: Date, year: number, month: number, day: number, hour: number, minute: number, timeZone: string, fallbackMs: number ): Date
{
    const next = createTZDate( year, month, day, hour, minute, timeZone );

    return next.getTime() > prev.getTime() ? next : new Date(( Math.floor( prev.getTime() / 60000 ) * 60000 ) + fallbackMs );
}

function normalizeMonthField( part: string ): string
{
    if( !ALPHA_RE.test( part ))
    {
        return part;
    }

    return part.toLowerCase().replace( MONTH_RE, m => MONTH_MAP[ m ]);
}

function normalizeDOWField( part: string ): string
{
    if( !ALPHA_RE.test( part ))
    {
        return part;
    }

    return part.toLowerCase().replace( /-sun\b/g, '-7' ).replace( DAY_RE, d => DAY_MAP[ d ]);
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
    let mask = 0;

    for( const val of values )
    {
        mask |= ( 1 << val );
    }

    return ( date ) => ( mask & ( 1 << date.getDate())) !== 0;
}

function parseDOWItem( item: string ): ( date: Date ) => boolean
{
    const lower = item.toLowerCase();

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
    let mask = 0;

    for( const val of rawValues )
    {
        mask |= ( 1 << ( val === 7 ? 0 : val ));
    }

    return ( date ) => ( mask & ( 1 << date.getDay())) !== 0;
}

export function getNextCronDate( cron: string, fromDate: Date = new Date(), timeZone?: string ): Date
{
    if( timeZone )
    {
        validateTimeZone( timeZone );
    }

    let parsed = cronCache.get( cron );

    if( !parsed )
    {
        const cacheKey = cron.trim().replace( MULTI_SPACE_RE, ' ' );
        parsed = cronCache.get( cacheKey );

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

            const nextMinute = buildNextLookup( minutes, 60, 0 );
            const nextHour = buildNextLookup( hours, 24, 0 );
            const nextMonth = buildNextLookup( months, 13, 1 );

            const domField = fields[ 2 ];
            const isDOMRestricted = domField !== '*' && domField !== '?';
            let isDOMMatch: ( date: Date ) => boolean;

            if( SPECIAL_DOM_RE.test( domField ))
            {
                const domMatchers = domField.split( ',' ).map( parseDOMItem );
                isDOMMatch = ( date: Date ) => domMatchers.some( m => m( date ));
            }
            else
            {
                isDOMMatch = parseDOMItem( domField );
            }

            const normalizedDOW = normalizeDOWField( fields[ 4 ]);
            const isDOWRestricted = fields[ 4 ] !== '*' && fields[ 4 ] !== '?';
            let isDOWMatch: ( date: Date ) => boolean;

            if( SPECIAL_DOW_RE.test( normalizedDOW ))
            {
                const dowMatchers = normalizedDOW.split( ',' ).map( parseDOWItem );
                isDOWMatch = ( date: Date ) => dowMatchers.some( m => m( date ));
            }
            else
            {
                isDOWMatch = parseDOWItem( normalizedDOW );
            }

            if( cronCache.size >= MAX_CRON_CACHE_SIZE )
            {
                cronCache.delete( cronCache.keys().next().value! );
            }

            parsed = { nextMinute, nextHour, nextMonth, isDOMRestricted, isDOWRestricted, isDOMMatch, isDOWMatch };
            cronCache.set( cacheKey, parsed );
        }
    }

    const { nextMinute, nextHour, nextMonth, isDOMRestricted, isDOWRestricted, isDOMMatch, isDOWMatch } = parsed;

    if( timeZone )
    {
        let current = new Date(( Math.floor( fromDate.getTime() / 60000 ) + 1 ) * 60000 );
        const limit = new Date( current.getTime());
        limit.setFullYear( limit.getFullYear() + 5 );
        const limitMs = limit.getTime();

        while( current.getTime() < limitMs )
        {
            const info = getTZParts( current, timeZone );
            const nextM = nextMonth[ info.month ];

            if( nextM !== info.month )
            {
                current = nextM === -1
                    ? createTZDate( info.year + 1, 1, 1, 0, 0, timeZone )
                    : createTZDate( info.year, nextM, 1, 0, 0, timeZone );

                continue;
            }

            if( isDOMRestricted || isDOWRestricted )
            {
                const localEquivalent = new Date( info.year, info.month - 1, info.day, info.hour, info.minute );

                if( isDOMRestricted && isDOWRestricted )
                {
                    if( !isDOMMatch( localEquivalent ) && !isDOWMatch( localEquivalent ))
                    {
                        current = createTZDate( info.year, info.month, info.day + 1, 0, 0, timeZone );

                        continue;
                    }
                }
                else if(( isDOMRestricted && !isDOMMatch( localEquivalent )) || ( isDOWRestricted && !isDOWMatch( localEquivalent )))
                {
                    current = createTZDate( info.year, info.month, info.day + 1, 0, 0, timeZone );

                    continue;
                }
            }

            const nextH = nextHour[ info.hour ];

            if( nextH !== info.hour )
            {
                current = nextH === -1
                    ? createTZDate( info.year, info.month, info.day + 1, 0, 0, timeZone )
                    : stepTZDate( current, info.year, info.month, info.day, nextH, 0, timeZone, ( 60 - info.minute ) * 60000 );

                continue;
            }

            const nextMin = nextMinute[ info.minute ];

            if( nextMin !== info.minute )
            {
                const delta = nextMin === -1 ? ( 60 - info.minute ) : ( nextMin - info.minute );
                current = new Date( current.getTime() + ( delta * 60000 ));

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
        const limitMs = limit.getTime();

        while( current.getTime() < limitMs )
        {
            const month = current.getMonth() + 1;
            const nextM = nextMonth[ month ];

            if( nextM !== month )
            {
                if( nextM === -1 )
                {
                    current.setFullYear( current.getFullYear() + 1, 0, 1 );
                }
                else
                {
                    current.setMonth( nextM - 1, 1 );
                }

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
            else if(( isDOMRestricted && !isDOMMatch( current )) || ( isDOWRestricted && !isDOWMatch( current )))
            {
                current.setDate( current.getDate() + 1 );
                current.setHours( 0, 0, 0, 0 );

                continue;
            }

            const hour = current.getHours();
            const nextH = nextHour[ hour ];

            if( nextH !== hour )
            {
                if( nextH === -1 )
                {
                    current.setDate( current.getDate() + 1 );
                    current.setHours( 0, 0, 0, 0 );
                }
                else
                {
                    current.setTime( current.getTime() + (( 60 - current.getMinutes()) * 60000 ));
                }

                continue;
            }

            const minute = current.getMinutes();
            const nextMin = nextMinute[ minute ];

            if( nextMin !== minute )
            {
                const delta = nextMin === -1 ? ( 60 - minute ) : ( nextMin - minute );
                current.setTime( current.getTime() + ( delta * 60000 ));

                continue;
            }

            return current;
        }
    }

    throw new Error( 'No matching execution date found within 5 years.' );
}
