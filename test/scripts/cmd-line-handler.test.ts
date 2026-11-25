import { CmdLineHandler } from '../../src/CmdLineHandler';

function assert(cond: boolean, msg: string): void {
    if (!cond) {
        console.error('FAIL:', msg);
        process.exit(1);
    }
    console.log('OK:', msg);
}

assert(CmdLineHandler.quoteString('plain', '"') === 'plain',
    'quote: plain arguments stay unquoted');
assert(CmdLineHandler.quoteString('E:/a b/x.exe', '"') === '"E:/a b/x.exe"',
    'quote: spaces are quoted');
assert(CmdLineHandler.quoteString('a&b', '"') === '"a&b"',
    'quote: cmd metacharacters are quoted');
assert(CmdLineHandler.quoteString('a^b(c)', '"') === '"a^b(c)"',
    'quote: parentheses and carets are quoted');
assert(CmdLineHandler.quoteString('x|y', '"') === '"x|y"',
    'quote: pipes are quoted');
assert(CmdLineHandler.quoteString('', '"') === '""',
    'quote: empty arguments are quoted');
assert(CmdLineHandler.quoteString('say "hi"', '"') === '"say ""hi"""',
    'quote: embedded double quotes are doubled');
assert(CmdLineHandler.quoteString("it's", "'") === "'it''s'",
    'quote: embedded single quotes are doubled for powershell');

assert(CmdLineHandler.getCommandLine('C:/tools/x.exe', ['-P', 'C:/a b.bin', 'x&y'])
    === 'C:/tools/x.exe -P "C:/a b.bin" "x&y"', 'quote: command line quoting');

console.log('All command line tests passed.');
export {};
