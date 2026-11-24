export class ConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ConfigError';
    }
}

export class CliUsageError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CliUsageError';
    }
}
