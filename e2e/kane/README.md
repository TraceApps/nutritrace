# End-to-end (e2e) tests for web

Browser tests written in plain English for [Kane CLI](https://www.testmuai.com/kane-cli/).

| Test | What it covers |
|---|---|
| `setup_test.md` | Creating the admin account in the first-run wizard and landing on the Diary |
| `diary_test.md` | Logging water, creating a custom food, and adding it to Breakfast |

## Run

Start NutriTrace on port 3001 with an empty data folder, for example with `docker compose up -d`. `setup_test.md` expects no users. `diary_test.md` expects one user `alex` with the password `Garden-2024!`:

```bash
curl -X POST http://localhost:3001/api/auth/register -H 'content-type: application/json' -d '{"username":"alex","password":"Garden-2024!"}'
```

```bash
npm install -g @testmuai/kane-cli
kane-cli login
kane-cli testmd run e2e/kane/setup_test.md
```
