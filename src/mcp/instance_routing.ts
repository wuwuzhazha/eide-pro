export interface InstanceSnapshot {
    instanceId: string;
    registeredAt: number;
    connected: boolean;
    projectUids: string[];
}

export type RoutingReason =
    | 'uid-owner' | 'earliest' | 'bound-default' | 'unknown-uid-fallback'
    | 'unavailable' | 'no-instance';

export interface InstanceRouteRequest {
    hintUid?: string | null;
    boundInstanceId?: string | null;
}

export interface InstanceRoute {
    instanceId: string | undefined;
    reason: RoutingReason;
}

function earliestInstance(instances: readonly InstanceSnapshot[]): InstanceSnapshot | undefined {
    let earliest: InstanceSnapshot | undefined;
    for (const instance of instances) {
        if (!earliest || instance.registeredAt < earliest.registeredAt) {
            earliest = instance;
        }
    }
    return earliest;
}

function routeTo(instance: InstanceSnapshot | undefined, reason: RoutingReason): InstanceRoute {
    if (instance === undefined) {
        return { instanceId: undefined, reason: 'no-instance' };
    }
    if (!instance.connected) {
        return { instanceId: undefined, reason: 'unavailable' };
    }
    return { instanceId: instance.instanceId, reason };
}

export function routeInstance(
    instances: readonly InstanceSnapshot[],
    request: InstanceRouteRequest
): InstanceRoute {
    if (instances.length === 0) {
        return { instanceId: undefined, reason: 'no-instance' };
    }
    if (request.hintUid) {
        const owner = instances.find(instance =>
            instance.projectUids.includes(request.hintUid!));
        if (owner) {
            return routeTo(owner, 'uid-owner');
        }
        if (request.boundInstanceId) {
            const bound = instances.find(instance =>
                instance.instanceId === request.boundInstanceId);
            return routeTo(bound, 'bound-default');
        }
    }
    return routeTo(earliestInstance(instances), request.hintUid
        ? 'unknown-uid-fallback' : 'earliest');
}
