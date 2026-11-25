export type SupportedFlashUploaderName =
    | 'JLink'
    | 'OpenOCD'
    | 'pyOCD'
    | 'STLink'
    | 'probe-rs';

export type UnsupportedFlashUploaderName =
    | 'STVP'
    | 'stcgal'
    | 'Custom';

export type FlashUploaderName = SupportedFlashUploaderName | UnsupportedFlashUploaderName;

export type FlashResultCode =
    | 'ok'
    | 'failed'
    | 'timeout'
    | 'not_supported'
    | 'invalid_request';

export type FlashVerifyMode = 'always' | 'optional' | 'unsupported';

export interface FlashProgram {
    path: string;
    address?: string;
}

export interface FlashRequestBase {
    programs: FlashProgram | FlashProgram[];
    address?: string;
    eraseAll?: boolean;
    verify?: boolean;
    timeoutMs?: number;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
}

export type JLinkInterface = 'SWD' | 'JTAG' | 'FINE' | 'cJTAG';

export interface JLinkFlashOptions {
    executable: string;
    device: string;
    interface?: JLinkInterface;
    speedKhz?: number;
    extraArgs?: string[];
    commandTemplate?: string;
}

export interface OpenOCDFlashOptions {
    executable: string;
    interfaceConfig: string;
    targetConfig: string;
    searchDir?: string;
    extraArgs?: string[];
}

export interface PyOCDFlashOptions {
    executable: string;
    target: string;
    configFile?: string;
    frequency?: string;
    extraArgs?: string[];
}

export type STLinkCLIVariant = 'stlink-cli' | 'cube-programmer';
export type STLinkProtocol = 'SWD' | 'JTAG';

export interface STLinkFlashOptions {
    executable: string;
    variant: STLinkCLIVariant;
    protocol?: STLinkProtocol;
    frequencyKhz?: number;
    resetMode?: string;
    runAfterProgram?: boolean;
    externalLoader?: string;
    optionBytes?: string[];
    extraArgs?: string[];
}

export type ProbeRSProtocol = 'swd' | 'jtag';

export interface ProbeRSFlashOptions {
    executable: string;
    chip: string;
    protocol?: ProbeRSProtocol;
    speedKhz?: number;
    workDir?: string;
    extraArgs?: string[];
}

export interface JLinkFlashRequest extends FlashRequestBase {
    uploader: 'JLink';
    options: JLinkFlashOptions;
}

export interface OpenOCDFlashRequest extends FlashRequestBase {
    uploader: 'OpenOCD';
    options: OpenOCDFlashOptions;
}

export interface PyOCDFlashRequest extends FlashRequestBase {
    uploader: 'pyOCD';
    options: PyOCDFlashOptions;
}

export interface STLinkFlashRequest extends FlashRequestBase {
    uploader: 'STLink';
    options: STLinkFlashOptions;
}

export interface ProbeRSFlashRequest extends FlashRequestBase {
    uploader: 'probe-rs';
    options: ProbeRSFlashOptions;
}

export interface UnsupportedFlashRequest extends FlashRequestBase {
    uploader: UnsupportedFlashUploaderName;
}

export type FlashRequest =
    | JLinkFlashRequest
    | OpenOCDFlashRequest
    | PyOCDFlashRequest
    | STLinkFlashRequest
    | ProbeRSFlashRequest
    | UnsupportedFlashRequest;

export interface FlashCommandScript {
    contents: string;
    extension: string;
}

export interface FlashCommand {
    executable: string;
    args: string[];
    verify: boolean;
    script?: FlashCommandScript;
}

export interface FlashCapabilities {
    uploader: FlashUploaderName;
    supported: boolean;
    program: boolean;
    eraseAll: boolean;
    verify: FlashVerifyMode;
    readback: boolean;
    reason?: string;
}

export interface FlashTool {
    readonly uploader: FlashUploaderName;
    readonly capabilities: FlashCapabilities;
}

export interface FlashResult {
    success: boolean;
    code: FlashResultCode;
    stdout: string;
    stderr: string;
    verified?: boolean;
    reason?: string;
}

export interface FlashReadbackRequest {
    uploader: FlashUploaderName;
    address: string;
    length: number;
    destination: string;
    timeoutMs?: number;
}

export interface FlashService {
    listTools(): FlashTool[];
    getCapabilities(uploader: FlashUploaderName): FlashCapabilities;
    flash(request: FlashRequest): Promise<FlashResult>;
    readback(request: FlashReadbackRequest): Promise<FlashResult>;
}
