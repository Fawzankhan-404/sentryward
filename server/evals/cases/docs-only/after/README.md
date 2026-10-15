# Inventory service

Tracks stock levels across warehouses and raises low-stock alerts.

## Running locally

```sh
cp .env.example .env
docker compose up
```

The API listens on port 3000. Set `PORT` in `.env` to change it.

## Running the tests

```sh
docker compose exec api npm test
```

Tests run against a separate `inventory_test` database that the compose file
creates on first start.
