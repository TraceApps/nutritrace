/**
 * The settings an admin can give everyone a default for (nutritrace#326),
 * with the values NutriTrace offers for each and the environment variable
 * that sets and locks it. The app's own pickers read these lists too
 * (Settings > Regional & Units, Connected Services), so the two can't
 * drift. Kept in server/lib because the server image has no src/.
 *
 * Weight, height, circumference, distance and temperature aren't here on
 * purpose: goals and some entries are bare numbers in the account's unit,
 * so a default that moved for someone who never chose would read a 180 lb
 * goal as 180 kg. Energy is stored in kcal and only shown in kJ, so it can.
 */
export const REGIONAL_OPTIONS = {
  language:          { env: 'DEFAULT_LANGUAGE',            values: ['en', 'fr', 'de', 'es', 'ru', 'nb'] },
  dateFormat:        { env: 'DEFAULT_DATE_FORMAT',         values: ['ISO', 'US', 'EU', 'natural'] },
  timeFormat:        { env: 'DEFAULT_TIME_FORMAT',         values: ['12h', '24h'] },
  energyUnit:        { env: 'DEFAULT_ENERGY_UNIT',         values: ['kcal', 'kJ'] },
  offSearchLanguage: { env: 'DEFAULT_OFF_SEARCH_LANGUAGE', values: ['en', 'fr', 'de', 'es', 'it', 'pt', 'nl', 'pl', 'ru', 'uk', 'ja', 'zh', 'ar', 'ko'] },
  offSearchCountry:  {
    env: 'DEFAULT_OFF_SEARCH_COUNTRY',
    values: ['World',
      'Argentina', 'Australia', 'Austria', 'Belgium', 'Brazil', 'Canada', 'Chile', 'China',
      'Denmark', 'Finland', 'France', 'Germany', 'India', 'Ireland', 'Italy', 'Japan',
      'Mexico', 'Netherlands', 'New Zealand', 'Norway', 'Poland', 'Portugal', 'Singapore',
      'South Africa', 'South Korea', 'Spain', 'Sweden', 'Switzerland', 'Ukraine',
      'United Kingdom', 'United States'],
  },
};
