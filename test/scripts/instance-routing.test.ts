const { routeInstance } = require('../../../src/mcp/instance_routing') as any;

function assert(condition: boolean, message: string): void {
    if (!condition) {
        console.error('FAIL:', message);
        process.exit(1);
    }
    console.log('OK:', message);
}

function instance(instanceId: string, registeredAt: number, projectUids: string[], connected = true): any {
    return { instanceId, registeredAt, connected, projectUids };
}

assert(JSON.stringify(routeInstance([
    instance('a', 1, ['uid-a']),
    instance('b', 2, ['uid-b'])
], { hintUid: 'uid-b' })) === JSON.stringify({ instanceId: 'b', reason: 'uid-owner' }),
'routing: uid owner');

assert(JSON.stringify(routeInstance([
    instance('a', 1, ['shared']),
    instance('b', 2, ['shared'])
], { hintUid: 'shared' })) === JSON.stringify({ instanceId: 'a', reason: 'uid-owner' }),
'routing: duplicate uid selects earliest deterministically');

assert(JSON.stringify(routeInstance([
    instance('a', 1, []),
    instance('b', 2, [])
], {})) === JSON.stringify({ instanceId: 'a', reason: 'earliest' }),
'routing: no hint selects earliest');

assert(JSON.stringify(routeInstance([
    instance('a', 1, [], false),
    instance('b', 2, [])
], {})) === JSON.stringify({ instanceId: undefined, reason: 'unavailable' }),
'routing: disconnected earliest is unavailable without falling through');

assert(JSON.stringify(routeInstance([
    instance('a', 1, [], false)
], {})) === JSON.stringify({ instanceId: undefined, reason: 'unavailable' }),
'routing: single disconnected instance is unavailable');

assert(JSON.stringify(routeInstance([], {})) === JSON.stringify({
    instanceId: undefined, reason: 'no-instance'
}), 'routing: empty list');

assert(JSON.stringify(routeInstance([
    instance('a', 1, ['uid-a']),
    instance('b', 2, ['uid-b'])
], { hintUid: 'missing', boundInstanceId: 'b' })) === JSON.stringify({
    instanceId: 'b', reason: 'bound-default'
}), 'routing: unknown uid uses connected bound instance');

assert(JSON.stringify(routeInstance([
    instance('a', 1, ['uid-a']),
    instance('b', 2, ['uid-b'], false)
], { hintUid: 'missing', boundInstanceId: 'b' })) === JSON.stringify({
    instanceId: undefined, reason: 'unavailable'
}), 'routing: disconnected bound instance is unavailable');

assert(JSON.stringify(routeInstance([
    instance('a', 1, ['uid-a']),
    instance('b', 2, ['uid-b'])
], { hintUid: 'missing' })) === JSON.stringify({
    instanceId: 'a', reason: 'unknown-uid-fallback'
}), 'routing: unknown uid without bound uses earliest');

console.log('instance routing tests passed');
export {};
