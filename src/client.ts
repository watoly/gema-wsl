import { GoogleGenAI } from '@google/genai';
import type { GemaConfig } from './config.js';

/**
 * 認証方式に応じて GoogleGenAI クライアントを生成する。
 * - apikey: Google AI Studio の API キー
 * - vertex: Vertex AI (gcloud の Application Default Credentials を使用)
 */
export function createClient(config: GemaConfig): GoogleGenAI {
  if (config.auth === 'vertex') {
    return new GoogleGenAI({
      vertexai: true,
      project: config.project,
      location: config.location || 'global',
    });
  }
  return new GoogleGenAI({ apiKey: config.apiKey });
}

/** 認証エラーを WSL 利用者向けの具体的な手順に翻訳する */
export function explainApiError(config: GemaConfig, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);

  if (/API key not valid|API_KEY_INVALID|401/i.test(message)) {
    return [
      'API キーが無効です。',
      '  https://aistudio.google.com/apikey で発行し直し、.env の GEMINI_API_KEY を更新してください。',
    ].join('\n');
  }
  if (/could not load the default credentials|ADC|application default/i.test(message)) {
    return [
      'Vertex AI の認証情報が見つかりません。WSL 上で以下を実行してください。',
      '  gcloud auth application-default login --no-launch-browser',
      `  gcloud config set project ${config.project ?? '<your-project-id>'}`,
    ].join('\n');
  }
  if (/PERMISSION_DENIED|403/i.test(message)) {
    return [
      'API へのアクセスが拒否されました。',
      config.auth === 'vertex'
        ? '  gcloud services enable aiplatform.googleapis.com で Vertex AI API を有効化してください。'
        : '  API キーに Generative Language API の権限があるか確認してください。',
    ].join('\n');
  }
  if (/RESOURCE_EXHAUSTED|429|quota/i.test(message)) {
    return 'レート制限またはクォータ超過です。少し待つか、/model で軽量モデルに切り替えてください。';
  }
  if (/NOT_FOUND|404/i.test(message)) {
    return `モデル "${config.model}" が見つかりません。/models で候補を確認し /model <id> で変更してください。`;
  }
  if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|fetch failed/i.test(message)) {
    return [
      'ネットワークに到達できません。WSL の DNS 設定を確認してください。',
      '  cat /etc/resolv.conf   # nameserver が引けているか',
      '  企業プロキシ配下なら HTTPS_PROXY / HTTP_PROXY を設定してください。',
    ].join('\n');
  }
  return message;
}
