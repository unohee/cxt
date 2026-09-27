import { createRequire } from 'node:module';
import type Parser from 'tree-sitter';
import { FrontendError, type AstLanguage } from './types.js';

const require = createRequire(import.meta.url);

/** 선언 추출과 규칙 검사가 같은 grammar 선택/실패 계약을 사용한다. */
export function createNativeParser(language: AstLanguage, filePath: string): { parser: Parser; grammar: Parser.Language; Query: typeof Parser.Query } {
  try {
    const NativeParser = require('tree-sitter') as typeof Parser;
    const javascript = language === 'typescript' && /\.(?:jsx?|mjs|cjs)$/.test(filePath);
    const grammar = javascript ? require('tree-sitter-javascript') as Parser.Language : language === 'typescript'
      ? (require('tree-sitter-typescript') as Record<string, Parser.Language>)[/\.[jt]sx$/.test(filePath) ? 'tsx' : 'typescript']
      : require(`tree-sitter-${language}`) as Parser.Language;
    const parser = new NativeParser(); parser.setLanguage(grammar); parser.setTimeoutMicros(500_000);
    return { parser, grammar, Query: NativeParser.Query };
  } catch (error) {
    throw new FrontendError({ code: 'parser-unavailable', filePath,
      message: `${language}: ${error instanceof Error ? error.message : String(error)}` });
  }
}

export function parseCheckedTree(parser: Parser, language: AstLanguage, filePath: string, content: string): Parser.Tree {
  const tree = parser.parse(content);
  if (!tree) throw new FrontendError({ code: 'syntax-error', filePath, message: 'Parser timeout or cancellation' });
  if (tree.rootNode.hasError) {
    let error = tree.rootNode;
    while (true) {
      const child = error.children.find(node => node.hasError || node.isMissing);
      if (!child) break;
      error = child;
    }
    throw new FrontendError({ code: 'syntax-error', filePath, message: `Invalid ${language} syntax`,
      line: error.startPosition.row + 1, column: error.startPosition.column + 1 });
  }
  return tree;
}

export function parseSyntaxTree(language: AstLanguage, filePath: string, content: string): Parser.Tree {
  return parseCheckedTree(createNativeParser(language, filePath).parser, language, filePath, content);
}
