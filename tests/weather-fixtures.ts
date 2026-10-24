import type { WeatherCity } from '../src/shared/types'

export const weatherCity: WeatherCity = { id: 1808926, name: '合肥', region: '安徽省', country: '中国', latitude: 31.86, longitude: 117.28, timezone: 'Asia/Shanghai' }
export const otherWeatherCity: WeatherCity = { ...weatherCity, id: 1796236, name: '上海', region: '上海市', latitude: 31.22, longitude: 121.46 }
export const weatherNow = Date.parse('2026-10-24T03:00:00Z')

export function cityResponse(cities = [weatherCity, otherWeatherCity]) {
  return { results: cities.map(city => ({ ...city, admin1: city.region })) }
}

export function forecastResponse(temperature = 22) {
  const day = Date.parse('2026-10-23T16:00:00Z') / 1000
  return {
    current: { time: weatherNow / 1000, temperature_2m: temperature, weather_code: 0, is_day: 1, wind_speed_10m: 8 },
    daily: { time: Array.from({ length: 7 }, (_, i) => day + i * 86400), weather_code: Array(7).fill(0), temperature_2m_min: Array(7).fill(15), temperature_2m_max: Array(7).fill(25), precipitation_probability_max: Array(7).fill(10), wind_speed_10m_max: Array(7).fill(12) },
    hourly: { time: Array.from({ length: 168 }, (_, i) => day + i * 3600), temperature_2m: Array(168).fill(temperature), precipitation_probability: Array(168).fill(10), wind_speed_10m: Array(168).fill(8), weather_code: Array(168).fill(0) }
  }
}
