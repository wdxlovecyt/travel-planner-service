import { createPrivateKey, sign } from "node:crypto";

const qWeatherKey = process.env.QWEATHER_API_KEY ?? "HE2106232041391383";
const qWeatherBaseUrl = process.env.QWEATHER_BASE_URL ?? "https://api.qweather.com";
const qWeatherJwtPrivateKey = process.env.QWEATHER_JWT_PRIVATE_KEY;
const qWeatherJwtKid = process.env.QWEATHER_JWT_KID;
const qWeatherJwtProjectId = process.env.QWEATHER_JWT_PROJECT_ID;

function toBase64Url(value: string | Buffer) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function buildQWeatherJwt() {
  if (!qWeatherJwtPrivateKey || !qWeatherJwtKid || !qWeatherJwtProjectId) {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  const iat = now - 30;
  const exp = iat + 900;
  const header = { alg: "EdDSA", kid: qWeatherJwtKid };
  const payload = { sub: qWeatherJwtProjectId, iat, exp };
  const encodedHeader = toBase64Url(JSON.stringify(header));
  const encodedPayload = toBase64Url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const keyObject = createPrivateKey(qWeatherJwtPrivateKey);
  const signature = sign(null, Buffer.from(signingInput), keyObject);
  const encodedSignature = toBase64Url(signature);
  return `${signingInput}.${encodedSignature}`;
}

async function callQWeather(pathname: string, params: Record<string, string>) {
  const url = new URL(pathname, qWeatherBaseUrl);
  const headers: Record<string, string> = {};

  Object.entries(params).forEach(([key, value]) => {
    url.searchParams.set(key, value);
  });

  const jwt = buildQWeatherJwt();
  if (jwt) {
    headers.Authorization = `Bearer ${jwt}`;
  } else if (qWeatherKey) {
    headers.Authorization = `Bearer ${qWeatherKey}`;
  } else {
    throw new Error("QWeather credential missing. Set QWEATHER_API_KEY or JWT envs.");
  }

  return fetch(url, { headers });
}

type GetWeatherInput = {
  city?: string;
  locationId: string;
};

export async function getWeather(input: GetWeatherInput) {
  const resolvedName = input.city?.trim() || "unknown";
  const weatherLocation = input.locationId.trim();
  if (!weatherLocation) {
    throw new Error("location_id is required for getWeather");
  }

  const weatherResponse = await callQWeather("/v7/weather/3d", {
    location: weatherLocation,
  });
  if (!weatherResponse.ok) {
    const details = await weatherResponse.text();
    throw new Error(`QWeather weather lookup failed ${weatherResponse.status}: ${details}`);
  }

  const weatherData = await weatherResponse.json();
  const daily = weatherData?.daily?.[0];
  if (!daily) {
    return JSON.stringify({
      city: resolvedName,
      weather_location: weatherLocation,
      error: "No daily weather data returned from QWeather",
      raw: weatherData,
    });
  }

  return JSON.stringify({
    city: resolvedName,
    weather_location: weatherLocation,
    date: daily?.fxDate ?? "unknown",
    temp_min_c: daily?.tempMin ?? "unknown",
    temp_max_c: daily?.tempMax ?? "unknown",
    condition_day: daily?.textDay ?? "unknown",
    condition_night: daily?.textNight ?? "unknown",
    wind_dir_day: daily?.windDirDay ?? "unknown",
    wind_scale_day: daily?.windScaleDay ?? "unknown",
    humidity: daily?.humidity ?? "unknown",
    source: "QWeather",
  });
}
