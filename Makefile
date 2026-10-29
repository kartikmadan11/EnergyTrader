.PHONY: install dev api web test lint format check

# Optional local configuration; see .env.example.
-include .env
export

install:
	uv sync --directory backend
	npm ci --prefix frontend

# Run the API on :8000 and the web app on :3000; Ctrl+C stops both.
dev:
	$(MAKE) -j2 api web

api:
	uv run --directory backend uvicorn main:app --reload --port 8000

web:
	npm run dev --prefix frontend

test:
	uv run --directory backend pytest

lint:
	uv run --directory backend ruff check .
	uv run --directory backend ruff format --check .
	npm run lint --prefix frontend
	npm run typecheck --prefix frontend

format:
	uv run --directory backend ruff check --fix .
	uv run --directory backend ruff format .

check: lint test
	npm run build --prefix frontend
