export declare const PLATFORM_ALIASES: Record<string, string>;
export declare function normalizePlatformAlias(platform: unknown): string;
export declare function isGeminiCliPlatform(platform: unknown): boolean;
export declare function isAntigravityPlatform(platform: unknown): boolean;
export declare function isInternalGeminiPlatform(platform: unknown): boolean;
export declare function detectPlatformByUrlHint(url: string): string | undefined;
