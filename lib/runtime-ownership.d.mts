export type RuntimeEnvironment = Record<string, string | undefined>;

export function hasConfiguredAgentRuntime(env?: RuntimeEnvironment): boolean;
export function shouldRunNotificationListenBridge(env?: RuntimeEnvironment): boolean;
