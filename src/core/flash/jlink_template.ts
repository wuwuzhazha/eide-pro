export const JLINK_FLASHER_COMMAND_PLACEHOLDER = '${EIDE_JLINK_FLASHER_CMD}';

export interface JLinkTemplateProgram {
    path: string;
    address?: string;
}

export function resolveJLinkProgramVariables(
    text: string, programs: JLinkTemplateProgram[]): string {

    if (programs.length === 0) {
        return text;
    }

    let result = text
        .replace(/\$\{hexFile\}|\$\{binFile\}|\$\{programFile\}/ig, programs[0].path);

    programs.forEach((program, index) => {
        result = result
            .replace(new RegExp(String.raw`\$\{hexFile\[${index}\]\}`, 'ig'), program.path)
            .replace(new RegExp(String.raw`\$\{binFile\[${index}\]\}`, 'ig'), program.path)
            .replace(new RegExp(String.raw`\$\{programFile\[${index}\]\}`, 'ig'), program.path);
        if (program.address) {
            result = result.replace(new RegExp(String.raw`\$\{binAddr\[${index}\]\}`, 'ig'), program.address);
        }
    });

    return result;
}

export function renderJLinkCommandFile(
    commands: string[], template: string | undefined, lineSeparator = '\n'): string {

    const body = template === undefined
        ? commands.join(lineSeparator)
        : template.split(JLINK_FLASHER_COMMAND_PLACEHOLDER).join(commands.join(lineSeparator));

    return `${body}${lineSeparator}exit`;
}
