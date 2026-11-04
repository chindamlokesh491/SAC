import { appendFile } from 'node:fs/promises';
import type { AppConfig } from '../config.js';

export type OtpSendResult = { providerMessageId?: string };
/** 'login' = sign-in codes (customer and partner); 'delivery' = the code a customer gives the delivery partner. */
export type OtpPurpose = 'login' | 'delivery';
export type OtpSender = (phone: string, code: string, purpose?: OtpPurpose) => Promise<OtpSendResult>;

/**
 * Generic HTTPS SMS adapter retained for gateways that accept POST {to, message}
 * with a bearer API key. SMS Gateway Hub uses its own DLT-aware adapter below.
 */
function httpSender(): OtpSender {
  return async (phone, code, purpose = 'login') => {
    const endpoint = process.env.OTP_SEND_URL;
    const apiKey = process.env.OTP_API_KEY;
    if (!endpoint || !apiKey) throw new Error('OTP provider is not configured');
    const url = new URL(endpoint);
    if (url.protocol !== 'https:') throw new Error('OTP provider endpoint must use HTTPS');
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ to: phone, message: purpose === 'delivery'
        ? `${code} is your Sri Anantha Cart delivery code. Share it only with the delivery partner when you receive your order. It expires in 10 minutes.`
        : `${code} is your Sri Anantha Cart verification code. It expires in 5 minutes. Do not share it with anyone.` }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`OTP provider returned HTTP ${response.status}`);
    return {};
  };
}

/**
 * SMS Gateway Hub SendSMS API. The API key is sent in the HTTPS form body,
 * never in the URL, so access logs cannot capture it. The configured DLT text
 * is preserved byte-for-byte except for its single approved variable slot.
 */
function smsGatewayHubSender(config: AppConfig): OtpSender {
  return async (phone, code, purpose = 'login') => {
    const apiKey = config.smsGatewayHubApiKey;
    const senderId = config.smsGatewayHubSenderId;
    const entityId = config.smsGatewayHubEntityId;
    // DLT rules bind each message to the purpose of its registered template: delivery codes are
    // never sent on the sign-in template. Without a delivery template the send fails cleanly and
    // the customer reads the code on their order screen.
    if (purpose === 'delivery' && (!config.smsGatewayHubDeliveryTemplateId || !config.smsGatewayHubDeliveryTemplateText)) {
      throw new Error('SMS Gateway Hub delivery-code DLT template is not configured');
    }
    const templateId = purpose === 'delivery' ? config.smsGatewayHubDeliveryTemplateId : config.smsGatewayHubOtpTemplateId;
    const templateText = purpose === 'delivery' ? config.smsGatewayHubDeliveryTemplateText : config.smsGatewayHubOtpTemplateText;
    if (!apiKey || !senderId || !entityId || !templateId || !templateText) {
      throw new Error('SMS Gateway Hub is not fully configured');
    }
    if (!phone.startsWith('+') || !/^[1-9][0-9]{7,14}$/.test(phone.slice(1))) throw new Error('SMS recipient must be an E.164 phone number');
    const number = phone.slice(1);
    const placeholder = ['{#var#}', '{#numeric#}', '{#alphanumeric#}'].find(value => templateText.includes(value));
    if (!placeholder) throw new Error('SMS Gateway Hub OTP template variable is missing');
    const message = templateText.replace(placeholder, code);
    const form = new URLSearchParams({
      APIKey: apiKey,
      senderid: senderId,
      channel: config.smsGatewayHubChannel,
      DCS: '0',
      flashsms: '0',
      number,
      text: message,
      EntityId: entityId,
      dlttemplateid: templateId,
    });
    if (config.smsGatewayHubRoute) form.set('route', config.smsGatewayHubRoute);

    const response = await fetch('https://www.smsgatewayhub.com/api/mt/SendSMS', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
        accept: 'application/json',
      },
      body: form.toString(),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`SMS Gateway Hub returned HTTP ${response.status}`);

    let result: { ErrorCode?: string | number; MessageData?: Array<{ MessageId?: string }> };
    try {
      result = await response.json() as typeof result;
    } catch {
      throw new Error('SMS Gateway Hub returned an invalid response');
    }
    if (String(result.ErrorCode) !== '000') {
      throw new Error('SMS Gateway Hub rejected the DLT message');
    }
    const providerMessageId = result.MessageData?.[0]?.MessageId;
    if (!providerMessageId) throw new Error('SMS Gateway Hub did not return a message ID');
    return { providerMessageId };
  };
}

/**
 * Development outbox. Production Node mode is allowed only behind the explicit
 * DEPLOYMENT_ENV=staging + ALLOW_DEV_OTP=true configuration gate.
 */
function devOutboxSender(path: string): OtpSender {
  return async (phone, code, purpose = 'login') => {
    await appendFile(path, `${JSON.stringify({ phone, code, purpose, at: new Date().toISOString() })}${String.fromCharCode(10)}`, { mode: 0o600 });
    return {};
  };
}

export function createOtpSender(config: AppConfig): OtpSender {
  if (config.otpProvider === 'dev-outbox' && (config.nodeEnv !== 'production' || config.allowDevOtp)) return devOutboxSender(config.otpDevOutboxPath!);
  if (config.otpProvider === 'http') return httpSender();
  if (config.otpProvider === 'smsgatewayhub') return smsGatewayHubSender(config);
  return async () => { throw new Error('OTP provider is not configured'); };
}
