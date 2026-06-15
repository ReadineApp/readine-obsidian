// Minimal ambient declarations for the `turndown` package (no @types/turndown shipped upstream).
// Covers only the API surface used by M-FORMAT-CONVERTER.

declare module "turndown" {
  export interface TurndownOptions {
    headingStyle?: "setext" | "atx";
    hr?: string;
    bulletListMarker?: "-" | "+" | "*";
    codeBlockStyle?: "indented" | "fenced";
    fence?: "```" | "~~~";
    emDelimiter?: "_" | "*";
    strongDelimiter?: "__" | "**";
    linkStyle?: "inlined" | "referenced";
    linkReferenceStyle?: "full" | "collapsed" | "shortcut";
    preformattedCode?: boolean;
    br?: string;
  }

  export default class TurndownService {
    constructor(options?: TurndownOptions);
    turndown(html: string): string;
    addRule(key: string, rule: unknown): this;
    keep(filter: unknown): this;
    remove(filter: unknown): this;
    use(plugin: unknown): this;
  }
}
