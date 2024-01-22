import {PortablePath, xfs}                                   from '@yarnpkg/fslib';
import {ExtendOptions, RequestError, Response, TimeoutError} from 'got';
import {Agent as HttpsAgent}                                 from 'https';
import {Agent as HttpAgent}                                  from 'http';
import micromatch                                            from 'micromatch';
import tunnel, {ProxyOptions}                                from 'tunnel';
import {URL}                                                 from 'url';

import {Configuration, ConfigurationValueMap}                from './Configuration';
import {EnhancedError}                                       from './EnhancedError';
import * as formatUtils                                      from './formatUtils';
import {MapValue, MapValueToObjectValue}                     from './miscUtils';

const cache = new Map<string, Promise<Buffer> | Buffer>();
const certCache = new Map<PortablePath, Promise<Buffer> | Buffer>();

const globalHttpAgent = new HttpAgent({keepAlive: true});
const globalHttpsAgent = new HttpsAgent({keepAlive: true});

function parseProxy(specifier: string) {
  const url = new URL(specifier);
  const proxy: ProxyOptions = {host: url.hostname, headers: {}};

  if (url.port)
    proxy.port = Number(url.port);

  return {proxy};
}

async function getCachedCertificate(caFilePath: PortablePath) {
  let certificate = certCache.get(caFilePath);

  if (!certificate) {
    certificate = xfs.readFilePromise(caFilePath).then(cert => {
      certCache.set(caFilePath, cert);
      return cert;
    });
    certCache.set(caFilePath, certificate);
  }

  return certificate;
}

/**
 * Searches through networkSettings and returns the most specific match
 */
export function getNetworkSettings(target: string, opts: { configuration: Configuration }) {
  // Sort the config by key length to match on the most specific pattern
  const networkSettings = [...opts.configuration.get(`networkSettings`)].sort(([keyA], [keyB]) => {
    return keyB.length - keyA.length;
  });

  type NetworkSettingsType = MapValueToObjectValue<MapValue<ConfigurationValueMap['networkSettings']>>;
  type UndefinableSettings = { [P in keyof NetworkSettingsType]: NetworkSettingsType[P] | undefined; };

  const mergedNetworkSettings: UndefinableSettings = {
    enableNetwork: undefined,
    caFilePath: undefined,
    httpProxy: undefined,
    httpsProxy: undefined,
  };

  const mergableKeys = Object.keys(mergedNetworkSettings) as Array<keyof NetworkSettingsType>;

  const url = new URL(target);
  for (const [glob, config] of networkSettings) {
    if (micromatch.isMatch(url.hostname, glob)) {
      for (const key of mergableKeys) {
        const setting = config.get(key);
        if (setting !== null && typeof mergedNetworkSettings[key] === `undefined`) {
          mergedNetworkSettings[key] = setting as any;
        }
      }
    }
  }

  // Apply defaults
  for (const key of mergableKeys) {
    if (typeof mergedNetworkSettings[key] === `undefined`) {
      mergedNetworkSettings[key] = opts.configuration.get(key) as any;
    }
  }

  return mergedNetworkSettings as NetworkSettingsType;
}

const prettifyResponseCode = ({statusCode, statusMessage}: Response, configuration: Configuration) => {
  const prettyStatusCode = formatUtils.pretty(configuration, statusCode, formatUtils.Type.NUMBER);
  const href = `https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/${statusCode}`;

  return formatUtils.applyHyperlink(configuration, `${prettyStatusCode}${statusMessage ? ` (${statusMessage})` : ``}`, href);
};

function enhanceRequestError(error: RequestError, configuration: Configuration) {
  const enhancedError = new EnhancedError(error, {includeStack: false}, configuration);

  if (error instanceof TimeoutError && error.event === `socket`) {
    EnhancedError.enhance(enhancedError, {
      summary: summary => `${summary} (can be increased via ${formatUtils.pretty(configuration, `httpTimeout`, formatUtils.Type.CONFIGURATION_SETTING)})`,
    });
  }

  if (error.request) {
    EnhancedError.enhance(enhancedError, {
      fields: [
        {label: `Request Method`, value: formatUtils.tuple(formatUtils.Type.NO_HINT, error.request.options.method)},
        {label: `Request URL`, value: formatUtils.tuple(formatUtils.Type.URL, error.request.requestUrl)},
      ],
    });

    if (error.request.redirects.length > 0) {
      EnhancedError.enhance(enhancedError, {
        fields: [
          {label: `Request Redirects`, value: formatUtils.tuple(formatUtils.Type.NO_HINT, formatUtils.prettyList(configuration, error.request.redirects, formatUtils.Type.URL))},
        ],
      });
    }
    if (error.request.retryCount === error.request.options.retry.limit) {
      EnhancedError.enhance(enhancedError, {
        fields: [
          {label: `Request Retry Count`, value: formatUtils.tuple(formatUtils.Type.NO_HINT, `${formatUtils.pretty(configuration, error.request.retryCount, formatUtils.Type.NUMBER)} (can be increased via ${formatUtils.pretty(configuration, `httpRetry`, formatUtils.Type.CONFIGURATION_SETTING)})`)},
        ],
      });
    }
  }

  if (error.response) {
    EnhancedError.enhance(enhancedError, {
      fields: [
        {label: `Response Code`, value: formatUtils.tuple(formatUtils.Type.NO_HINT, prettifyResponseCode(error.response, configuration))},
      ],
    });
  }

  return enhancedError;
}

export type Body = (
  {[key: string]: any} |
  string |
  Buffer |
  null
);

export enum Method {
  GET = `GET`,
  PUT = `PUT`,
  POST = `POST`,
  DELETE = `DELETE`,
}

export type Options = {
  configuration: Configuration,
  headers?: {[headerName: string]: string};
  jsonRequest?: boolean,
  jsonResponse?: boolean,
  method?: Method,
};

export async function request(target: string, body: Body, {configuration, headers, jsonRequest, jsonResponse, method = Method.GET}: Options) {
  const networkConfig = getNetworkSettings(target, {configuration});
  if (networkConfig.enableNetwork === false)
    throw new Error(`Request to '${target}' has been blocked because of your configuration settings`);

  const url = new URL(target);
  if (url.protocol === `http:` && !micromatch.isMatch(url.hostname, configuration.get(`unsafeHttpWhitelist`)))
    throw new Error(`Unsafe http requests must be explicitly whitelisted in your configuration (${url.hostname})`);

  const agent = {
    http: networkConfig.httpProxy
      ? tunnel.httpOverHttp(parseProxy(networkConfig.httpProxy))
      : globalHttpAgent,
    https: networkConfig.httpsProxy
      ? tunnel.httpsOverHttp(parseProxy(networkConfig.httpsProxy)) as HttpsAgent
      : globalHttpsAgent,
  };

  const gotOptions: ExtendOptions = {agent, headers, method};
  gotOptions.responseType = jsonResponse
    ? `json`
    : `buffer`;

  if (body !== null) {
    if (Buffer.isBuffer(body) || (!jsonRequest && typeof body === `string`)) {
      gotOptions.body = body;
    } else {
      // @ts-expect-error: The got types only allow an object, but got can stringify any valid JSON
      gotOptions.json = body;
    }
  }

  const socketTimeout = configuration.get(`httpTimeout`);
  const retry = configuration.get(`httpRetry`);
  const rejectUnauthorized = configuration.get(`enableStrictSsl`);
  const caFilePath = networkConfig.caFilePath;

  const {default: got} = await import(`got`);

  const certificateAuthority = caFilePath
    ? await getCachedCertificate(caFilePath)
    : undefined;

  const gotClient = got.extend({
    timeout: {
      socket: socketTimeout,
    },
    retry,
    https: {
      rejectUnauthorized,
      certificateAuthority,
    },
    ...gotOptions,
  });

  return configuration.getLimit(`networkConcurrency`)(() => {
    return gotClient(target).catch(error => {
      if (error instanceof RequestError)
        throw enhanceRequestError(error, configuration);

      throw error;
    }) as unknown as Response<any>;
  });
}

export async function get(target: string, {configuration, jsonResponse, ...rest}: Options) {
  let entry = cache.get(target);

  if (!entry) {
    entry = request(target, null, {configuration, ...rest}).then(response => {
      cache.set(target, response.body);
      return response.body;
    });
    cache.set(target, entry);
  }

  if (Buffer.isBuffer(entry) === false)
    entry = await entry;

  if (jsonResponse) {
    return JSON.parse(entry.toString());
  } else {
    return entry;
  }
}

export async function put(target: string, body: Body, options: Options): Promise<Buffer> {
  const response = await request(target, body, {...options, method: Method.PUT});

  return response.body;
}

export async function post(target: string, body: Body, options: Options): Promise<Buffer> {
  const response = await request(target, body, {...options, method: Method.POST});

  return response.body;
}

export async function del(target: string, options: Options): Promise<Buffer> {
  const response = await request(target, null, {...options, method: Method.DELETE});

  return response.body;
}
