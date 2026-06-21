const MONTH_NAMES = [ 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec' ];
const DAY_NAMES = [ 'sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat' ];

type ParsedCron =
{
    minutes         : Set<number>
    hours           : Set<number>
    months          : Set<number>
    isDOMRestricted : boolean
    isDOWRestricted : boolean
    isDOMMatch      : ( date: Date ) => boolean
    isDOWMatch      : ( date: Date ) => boolean
}

const cronCache = new Map<string, ParsedCron>();

const formatters = new Map<string, Intl.DateTimeFormat>();

function getFormatter( timeZone: string ): Intl.DateTimeFormat
{
    let f = formatters.get( timeZone );

    if( !f )
    {
        f = new Intl.DateTimeFormat( 'en-US', {
            timeZone,
            hour12 : false,
            year   : 'numeric',
            month  : 'numeric',
            day    : 'numeric',
            hour   : 'numeric',
            minute : 'numeric',
            second : 'numeric'
        });

        formatters.set( timeZone, f );
    }

    return f;
}

export function validateTimeZone( timeZone: string )
{
    try
    {
        Intl.DateTimeFormat( undefined, { timeZone } );
    }
    catch( e )
    {
        throw new Error( 'Invalid timezone: ' + timeZone );
    }
}

function getTZOffset( date: Date, timeZone: string ): number
{
    const formatter = getFormatter( timeZone );
    const parts = formatter.formatToParts( date );
    const dict: Record<string, number> = {};

    for( const p of parts )
    {
        const val = parseInt( p.value, 10 );

        if( p.type !== 'literal' )
        {
            dict[ p.type ] = p.type === 'hour' && val === 24 ? 0 : val;
        }
    }

    const utc = Date.UTC( dict.year, dict.month - 1, dict.day, dict.hour, dict.minute, dict.second );

    return date.getTime() - utc;
}

function createTZDate( year: number, month: number, day: number, hour: number, minute: number, timeZone: string ): Date
{
    const utcEstimate = new Date( Date.UTC( year, month - 1, day, hour, minute ) );
    const offset = getTZOffset( utcEstimate, timeZone );
    const result = new Date( utcEstimate.getTime() + offset );
    const actualOffset = getTZOffset( result, timeZone );

    if( actualOffset !== offset )
    {
        return new Date( utcEstimate.getTime() + actualOffset );
    }

    return result;
}

type TZDateInfo =
{
    year    : number
    month   : number
    day     : number
    hour    : number
    minute  : number
    weekday : number
}

function getTZDateInfo( date: Date, timeZone: string ): TZDateInfo
{
    const formatter = getFormatter( timeZone );
    const parts = formatter.formatToParts( date );
    const dict: Record<string, number> = {};

    for( const p of parts )
    {
        const val = parseInt( p.value, 10 );

        if( p.type !== 'literal' )
        {
            dict[ p.type ] = p.type === 'hour' && val === 24 ? 0 : val;
        }
    }

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

function normalizeCronPart( part: string, isMonth: boolean ): string
{
    let p = part.toLowerCase();

    if( isMonth )
    {
        for( let i = 0; i < 12; i++ )
        {
            p = p.replace( new RegExp( MONTH_NAMES[ i ], 'g' ), String( i + 1 ) );
        }
    }
    else
    {
        for( let i = 0; i < 7; i++ )
        {
            p = p.replace( new RegExp( DAY_NAMES[ i ], 'g' ), String( i ) );
        }

        p = p.replace( /7/g, '0' );
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
        else if( part.includes( '/' ) )
        {
            const [ range, stepStr ] = part.split( '/' );
            const step = parseInt( stepStr, 10 );

            if( isNaN( step ) || step <= 0 )
            {
                throw new Error( 'Invalid step value.' );
            }

            let start = min;
            let end = max;

            if( range !== '*' && range !== '?' )
            {
                if( range.includes( '-' ) )
                {
                    const rangeParts = range.split( '-' );

                    if( rangeParts.length !== 2 )
                    {
                        throw new Error( 'Invalid range syntax for step.' );
                    }

                    const [ s, e ] = rangeParts.map( Number );

                    if( isNaN( s ) || isNaN( e ) || s < min || e > max || s > e )
                    {
                        throw new Error( 'Invalid range for step.' );
                    }

                    start = s;
                    end = e;
                }
                else
                {
                    const s = parseInt( range, 10 );

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
        else if( part.includes( '-' ) )
        {
            const rangeParts = part.split( '-' );

            if( rangeParts.length !== 2 )
            {
                throw new Error( 'Invalid range syntax.' );
            }

            const [ start, end ] = rangeParts.map( Number );

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
            const val = parseInt( part, 10 );

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
    let day = Math.min( targetDay, totalDays );
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
    if( item === '*' || item === '?' )
    {
        return () => true;
    }

    if( item.toLowerCase() === 'l' )
    {
        return ( date ) =>
        {
            const lastDay = new Date( date.getFullYear(), date.getMonth() + 1, 0 ).getDate();

            return date.getDate() === lastDay;
        };
    }

    if( item.toLowerCase() === 'lw' || item.toLowerCase() === 'l-w' )
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

    if( item.toLowerCase().endsWith( 'w' ) )
    {
        const targetDay = parseInt( item, 10 );

        return ( date ) =>
        {
            return date.getDate() === getNearestWeekday( date.getFullYear(), date.getMonth(), targetDay );
        };
    }

    const values = parseCronField( item, 1, 31 );

    return ( date ) => values.has( date.getDate() );
}

function parseDOWItem( item: string ): ( date: Date ) => boolean
{
    if( item === '*' || item === '?' )
    {
        return () => true;
    }

    if( item.toLowerCase().endsWith( 'l' ) )
    {
        const dayVal = parseInt( item, 10 );
        const targetDay = dayVal === 7 ? 0 : dayVal;

        return ( date ) =>
        {
            if( date.getDay() !== targetDay ){ return false }

            const totalDays = new Date( date.getFullYear(), date.getMonth() + 1, 0 ).getDate();

            return date.getDate() + 7 > totalDays;
        };
    }

    if( item.includes( '#' ) )
    {
        const [ dayStr, occurrenceStr ] = item.split( '#' );
        const dayVal = parseInt( dayStr, 10 );
        const targetDay = dayVal === 7 ? 0 : dayVal;
        const targetOccurrence = parseInt( occurrenceStr, 10 );

        return ( date ) =>
        {
            if( date.getDay() !== targetDay ){ return false }

            const occurrence = Math.floor( ( date.getDate() - 1 ) / 7 ) + 1;

            return occurrence === targetOccurrence;
        };
    }

    const rawValues = parseCronField( item, 0, 7 );
    const values = new Set<number>();

    for( const val of rawValues )
    {
        values.add( val === 7 ? 0 : val );
    }

    return ( date ) => values.has( date.getDay() );
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
        const fields = cron.trim().split( /\s+/ );

        if( fields.length !== 5 )
        {
            throw new Error( 'Invalid cron expression. Only 5-field expressions are supported.' );
        }

        const minutes = parseCronField( normalizeCronPart( fields[ 0 ], false ), 0, 59 );
        const hours = parseCronField( normalizeCronPart( fields[ 1 ], false ), 0, 23 );
        const months = parseCronField( normalizeCronPart( fields[ 3 ], true ), 1, 12 );

        const domParts = normalizeCronPart( fields[ 2 ], false ).split( ',' );
        const domMatchers = domParts.map( parseDOMItem );
        const isDOMRestricted = fields[ 2 ] !== '*' && fields[ 2 ] !== '?';
        const isDOMMatch = ( date: Date ) => domMatchers.some( m => m( date ) );

        const dowParts = normalizeCronPart( fields[ 4 ], false ).split( ',' );
        const dowMatchers = dowParts.map( parseDOWItem );
        const isDOWRestricted = fields[ 4 ] !== '*' && fields[ 4 ] !== '?';
        const isDOWMatch = ( date: Date ) => dowMatchers.some( m => m( date ) );

        cronCache.set( cron, parsed = { minutes, hours, months, isDOMRestricted, isDOWRestricted, isDOMMatch, isDOWMatch } );
    }

    const { minutes, hours, months, isDOMRestricted, isDOWRestricted, isDOMMatch, isDOWMatch } = parsed;

    if( timeZone )
    {
        const infoStart = getTZDateInfo( fromDate, timeZone );
        let current = createTZDate( infoStart.year, infoStart.month, infoStart.day, infoStart.hour, infoStart.minute + 1, timeZone );
        const limit = new Date( current.getTime() );
        limit.setFullYear( limit.getFullYear() + 5 );

        while( current.getTime() < limit.getTime() )
        {
            const info = getTZDateInfo( current, timeZone );

            if( !months.has( info.month ) )
            {
                current = createTZDate( info.year, info.month + 1, 1, 0, 0, timeZone );

                continue;
            }

            const localEquivalent = new Date( info.year, info.month - 1, info.day, info.hour, info.minute );

            if( isDOMRestricted && isDOWRestricted )
            {
                if( !isDOMMatch( localEquivalent ) && !isDOWMatch( localEquivalent ) )
                {
                    current = createTZDate( info.year, info.month, info.day + 1, 0, 0, timeZone );

                    continue;
                }
            }
            else
            {
                if( isDOMRestricted && !isDOMMatch( localEquivalent ) )
                {
                    current = createTZDate( info.year, info.month, info.day + 1, 0, 0, timeZone );

                    continue;
                }

                if( isDOWRestricted && !isDOWMatch( localEquivalent ) )
                {
                    current = createTZDate( info.year, info.month, info.day + 1, 0, 0, timeZone );

                    continue;
                }
            }

            if( !hours.has( info.hour ) )
            {
                current = createTZDate( info.year, info.month, info.day, info.hour + 1, 0, timeZone );

                continue;
            }

            if( !minutes.has( info.minute ) )
            {
                current = createTZDate( info.year, info.month, info.day, info.hour, info.minute + 1, timeZone );

                continue;
            }

            return current;
        }
    }
    else
    {
        let current = new Date( fromDate.getTime() );
        current.setSeconds( 0, 0 );
        current.setMinutes( current.getMinutes() + 1 );
        const limit = new Date( current.getTime() );
        limit.setFullYear( limit.getFullYear() + 5 );

        while( current.getTime() < limit.getTime() )
        {
            const month = current.getMonth() + 1;

            if( !months.has( month ) )
            {
                current.setMonth( current.getMonth() + 1 );
                current.setDate( 1 );
                current.setHours( 0, 0, 0, 0 );

                continue;
            }

            if( isDOMRestricted && isDOWRestricted )
            {
                if( !isDOMMatch( current ) && !isDOWMatch( current ) )
                {
                    current.setDate( current.getDate() + 1 );
                    current.setHours( 0, 0, 0, 0 );

                    continue;
                }
            }
            else
            {
                if( isDOMRestricted && !isDOMMatch( current ) )
                {
                    current.setDate( current.getDate() + 1 );
                    current.setHours( 0, 0, 0, 0 );

                    continue;
                }

                if( isDOWRestricted && !isDOWMatch( current ) )
                {
                    current.setDate( current.getDate() + 1 );
                    current.setHours( 0, 0, 0, 0 );

                    continue;
                }
            }

            const hour = current.getHours();

            if( !hours.has( hour ) )
            {
                current.setHours( current.getHours() + 1 );
                current.setMinutes( 0, 0, 0 );

                continue;
            }

            const minute = current.getMinutes();

            if( !minutes.has( minute ) )
            {
                current.setMinutes( current.getMinutes() + 1 );

                continue;
            }

            return current;
        }
    }

    throw new Error( 'No matching execution date found within 5 years.' );
}
