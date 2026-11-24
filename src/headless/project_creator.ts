import * as child_process from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as NodePath from 'path';
import * as yaml from 'yaml';
import {
    dumpProjectConfig,
    migrateProjectConfig,
    needsProjectConfigMigration
} from '../core/project_config_migration';
import { CliUsageError, ConfigError } from '../core/errors';

export interface HeadlessTemplate {
    name: string;
    type: string;
    description: string;
}

const CURRENT_CONFIG_VERSION = '4.1';
const TEMPLATE_EXTRACT_TIMEOUT_MS = 120_000;

export const HEADLESS_TEMPLATES: readonly HeadlessTemplate[] = [
    { name: 'mcs51_sdcc', type: 'C51', description: '8051 Quick Start (SDCC)' },
    { name: 'stc15_sdcc', type: 'C51', description: 'STC15 Quick Start (SDCC)' },
    { name: 'stm8_cosmic_empty', type: 'C51', description: 'STM8 Empty Project (COSMIC)' },
    { name: 'stm8s_cosmic', type: 'C51', description: 'STM8S Quick Start (COSMIC)' },
    { name: 'stm8s_sdcc', type: 'C51', description: 'STM8S Quick Start (SDCC)' },
    { name: 'stm32f1xx_gcc', type: 'ARM', description: 'STM32F103 Cortex-M3 Quick Start (GCC)' },
    { name: 'gd32vf103_riscv', type: 'RISC-V', description: 'GD32VF103 RISC-V Quick Start' },
    { name: 'avr_atmega128_rtos', type: 'ANY-GCC', description: 'AVR FreeRTOS Quick Start' }
];

export interface CreateProjectOptions {
    name: string;
    outputDir: string;
    template: string;
    resourcesDir: string;
    projectName?: string;
}

export interface CreateProjectResult {
    success: boolean;
    command: 'create';
    projectPath: string;
    workspaceFile: string;
    template: string;
    type: string;
    uid: string;
    files: number;
}

function usageError(message: string): never {
    throw new CliUsageError(message);
}

function configError(message: string): never {
    throw new ConfigError(message);
}

function listFiles(root: string): string[] {
    const result: string[] = [];
    const visit = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = NodePath.join(dir, entry.name);
            if (entry.isDirectory()) {
                visit(full);
            } else {
                result.push(full);
            }
        }
    };
    visit(root);
    return result;
}

function sevenZipExecutable(resourcesDir: string): string {
    const suffix = process.platform === 'win32' ? '.exe' : '';
    const executable = NodePath.join(
        NodePath.resolve(resourcesDir), 'tools', process.platform, '7z', `7za${suffix}`);
    if (!fs.existsSync(executable)) {
        configError(`7z executable not found: ${executable}`);
    }
    return executable;
}

function extractTemplate(templateFile: string, targetDir: string, resourcesDir: string): void {
    fs.mkdirSync(targetDir, { recursive: true });
    const result = child_process.execFileSync(sevenZipExecutable(resourcesDir), [
        'x', '-y', '-r', '-aoa', templateFile, `-o${targetDir}`
    ], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: TEMPLATE_EXTRACT_TIMEOUT_MS
    });
    if (result === undefined) {
        configError(`Failed to extract template: ${templateFile}`);
    }
}

function normalizePathSeparators(config: any): void {
    if (config === null || typeof config !== 'object') {
        return;
    }
    if (Array.isArray(config)) {
        for (const item of config) {
            normalizePathSeparators(item);
        }
        return;
    }
    const pathKeys = ['scatterFilePath', 'srcDirs', 'incList', 'libList', 'excludeList', 'path'];
    for (const key of Object.keys(config)) {
        const value = config[key];
        if (pathKeys.includes(key) && typeof value === 'string') {
            config[key] = value.replace(/\\/g, '/').replace(/^\.\//, '');
        } else if (Array.isArray(value)) {
            for (let index = 0; index < value.length; index++) {
                if (typeof value[index] === 'string') {
                    value[index] = value[index].replace(/\\/g, '/');
                } else {
                    normalizePathSeparators(value[index]);
                }
            }
        } else if (value !== null && typeof value === 'object') {
            normalizePathSeparators(value);
        }
    }
}

function readConfig(projectDir: string): { config: any; file: string } {
    const jsonFile = NodePath.join(projectDir, '.eide', 'eide.json');
    const ymlFile = NodePath.join(projectDir, '.eide', 'eide.yml');
    const file = fs.existsSync(ymlFile) ? ymlFile : jsonFile;
    if (!fs.existsSync(file)) {
        configError(`Template has no .eide/eide.json or .eide/eide.yml: ${projectDir}`);
    }
    const config = yaml.parse(fs.readFileSync(file, 'utf8'));
    if (config === null || typeof config !== 'object' || Array.isArray(config)) {
        configError(`Invalid project configuration in template: ${file}`);
    }
    return { config, file };
}

export function createProject(options: CreateProjectOptions): CreateProjectResult {
    const template = HEADLESS_TEMPLATES.find(item => item.name === options.template);
    if (!template) {
        usageError(`Unknown template: ${options.template}. Available: ${
            HEADLESS_TEMPLATES.map(item => item.name).join(', ')}`);
    }
    const name = options.name.trim();
    if (name === '') {
        usageError('Project name must not be empty.');
    }
    if (/\s/.test(name)) {
        usageError('Project name cannot contain whitespace.');
    }
    if (/[&<>()@^|]/.test(name)) {
        usageError('Project name contains invalid characters.');
    }

    const templateFile = NodePath.join(
        NodePath.resolve(options.resourcesDir), 'template', `${template.name}.ept`);
    if (!fs.existsSync(templateFile)) {
        configError(`Template file not found: ${templateFile}`);
    }
    const projectPath = NodePath.resolve(options.outputDir, name);
    if (fs.existsSync(projectPath)) {
        configError(`Project directory already exists: ${projectPath}`);
    }

    extractTemplate(templateFile, projectPath, options.resourcesDir);

    const workspaces = fs.readdirSync(projectPath)
        .filter(entry => entry.endsWith('.code-workspace'));
    if (workspaces.length === 0) {
        configError(`Template has no .code-workspace file: ${templateFile}`);
    }
    const workspaceFile = NodePath.join(projectPath, `${options.projectName || name}.code-workspace`);
    const sourceWorkspace = NodePath.join(projectPath, workspaces[0]);
    if (sourceWorkspace !== workspaceFile) {
        fs.renameSync(sourceWorkspace, workspaceFile);
    }

    const { config, file } = readConfig(projectPath);
    if (needsProjectConfigMigration(config)) {
        migrateProjectConfig(config);
    }
    normalizePathSeparators(config);
    config.version = CURRENT_CONFIG_VERSION;
    config.name = options.projectName || name;
    config.miscInfo = config.miscInfo || {};
    const uid = crypto.randomBytes(16).toString('hex');
    config.miscInfo.uid = uid;

    const ymlFile = NodePath.join(projectPath, '.eide', 'eide.yml');
    fs.writeFileSync(ymlFile, dumpProjectConfig(config), 'utf8');
    if (file !== ymlFile && fs.existsSync(file)) {
        fs.unlinkSync(file);
    }

    const contextFile = NodePath.join(projectPath, '.eide.usr.ctx.json');
    if (fs.existsSync(contextFile)) {
        fs.unlinkSync(contextFile);
    }

    return {
        success: true,
        command: 'create',
        projectPath,
        workspaceFile,
        template: template.name,
        type: template.type,
        uid,
        files: listFiles(projectPath).length
    };
}
