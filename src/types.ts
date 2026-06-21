export type RetryOptions =
{
    attempts? : number
    delay?    : number
    backoff?  : 'constant' | 'exponential'
}

export type TimerOptions<Data = any> =
{
    offset?   : number
    expires?  : Date | number
    data?     : Data
    interval? : number
    retry?    : RetryOptions | null
    timezone? : string
}

export type TimerConstructorOptions =
{
    timezone? : string
    retry?    : RetryOptions
}

export type TimerEntry =
{
    id                 : string
    deadline           : number
    expires?           : number
    callback           : TimerCallback
    data               : any
    cron?              : string
    interval?          : number
    retry?             : RetryOptions
    retryAttempt?      : number
    nextRegularFiring? : number
    timezone?          : string
    paused?            : boolean
    version?           : number
}

export type TimerCallback<Data = any> = ( context: { id: string, data: Data } ) => any;
