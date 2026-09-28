.PHONY: dev dev-server dev-app dev-auth-config install lint typecheck test test-coverage \
	validate-template e2e smoke package-server deploy-backend deploy-frontend deploy destroy \
	rotate-origin-secret

# CloudFormation stack the infra/ SAM template deploys into. It MUST reach
# `sam deploy` itself (samconfig.toml carries its own stack_name and would
# otherwise win), so it is threaded through SAM_DEPLOY_ARGS below. Staging and
# Production are the same stack name in two different accounts; CI picks the
# account through the environment's AWS_DEPLOY_ROLE_ARN.
STACK_NAME ?= ai-fantasy-league
# Region for deploys. Empty means "whatever samconfig.toml/AWS_REGION says";
# CI sets it explicitly so the stack can never land in a surprise region.
DEPLOY_REGION ?=
# Threaded into every `sam deploy`. `--resolve-s3` is SAM's own managed bucket
# for the packaged template; the API zip goes to the stack's ArtifactBucket.
SAM_DEPLOY_ARGS ?= --stack-name $(STACK_NAME) \
	$(if $(DEPLOY_REGION),--region $(DEPLOY_REGION),) \
	--resolve-s3 \
	--no-fail-on-empty-changeset
REGION_ARG = $(if $(DEPLOY_REGION),--region $(DEPLOY_REGION),)
# Where scripts/package-server.sh stages and zips the API artifact.
SERVER_BUILD_DIR ?= $(CURDIR)/.build/server
SERVER_DEV_ENTRY = packages/server/src/local.ts

# Reads one output of $(STACK_NAME). Empty (not an error) when the stack or
# the output does not exist.
define resolve_output_fn
	resolve_output() { \
		aws cloudformation describe-stacks --stack-name $(STACK_NAME) $(REGION_ARG) \
			--query "Stacks[0].Outputs[?OutputKey=='$$1'].OutputValue" \
			--output text 2>/dev/null || true; \
	}
endef

# The CloudFront origin-verify secret (#104): two SSM String parameters under
# /<stack>/origin-verify/. The template resolves them on every deploy, so the
# value is stable until rotated. `ensure_origin_secret` creates them (a fresh
# `openssl rand -hex 32`, previous = current) the first time a stack deploys.
ORIGIN_SECRET_PREFIX = /$(STACK_NAME)/origin-verify
ORIGIN_SECRET_OVERRIDES = "OriginVerifySecret=$(ORIGIN_SECRET_PREFIX)/current" \
	"OriginVerifySecretPrevious=$(ORIGIN_SECRET_PREFIX)/previous"
define ensure_origin_secret_fn
	ensure_origin_secret() { \
		if ! aws ssm get-parameter --name "$(ORIGIN_SECRET_PREFIX)/current" $(REGION_ARG) >/dev/null 2>&1; then \
			echo "deploy-backend: creating the origin-verify secret $(ORIGIN_SECRET_PREFIX)/current"; \
			secret=$$(openssl rand -hex 32); \
			aws ssm put-parameter --name "$(ORIGIN_SECRET_PREFIX)/current" --type String \
				--value "$$secret" $(REGION_ARG) >/dev/null; \
		fi; \
		if ! aws ssm get-parameter --name "$(ORIGIN_SECRET_PREFIX)/previous" $(REGION_ARG) >/dev/null 2>&1; then \
			current=$$(aws ssm get-parameter --name "$(ORIGIN_SECRET_PREFIX)/current" $(REGION_ARG) \
				--query Parameter.Value --output text); \
			aws ssm put-parameter --name "$(ORIGIN_SECRET_PREFIX)/previous" --type String \
				--value "$$current" $(REGION_ARG) >/dev/null; \
		fi; \
	}
endef

# --------------------------------------------------------------------------- #
# dev
#
# Runs the local API server (port 8787) and the SPA (Vite, port 5173, which
# proxies /api to 8787) in one terminal. The trap forwards Ctrl-C (and any
# exit) to both background jobs. The API half starts only once the server
# package has its local entrypoint; until then `make dev` runs the SPA alone.
# Use `make dev-server` / `make dev-app` for separate terminals.
# --------------------------------------------------------------------------- #

dev:
	@trap 'kill 0' EXIT INT TERM; \
	if [ -f $(SERVER_DEV_ENTRY) ]; then \
		if grep -q '"dev"' packages/server/package.json 2>/dev/null; then \
			npm run dev --workspace=packages/server & \
		else \
			npx --yes tsx watch $(SERVER_DEV_ENTRY) & \
		fi; \
	else \
		echo "dev: $(SERVER_DEV_ENTRY) does not exist yet; starting the SPA only"; \
	fi; \
	npm run dev --workspace=app & \
	wait

dev-server:
	@if [ ! -f $(SERVER_DEV_ENTRY) ]; then echo "dev-server: $(SERVER_DEV_ENTRY) does not exist yet" >&2; exit 1; fi; \
	if grep -q '"dev"' packages/server/package.json 2>/dev/null; then \
		npm run dev --workspace=packages/server; \
	else \
		npx --yes tsx watch $(SERVER_DEV_ENTRY); \
	fi

dev-app:
	npm run dev --workspace=app

# Point a local SPA at a deployed stack's app client: writes
# app/public/auth-config.json (gitignored) from the stack's outputs.
#   make dev-auth-config STACK_NAME=ai-fantasy-league DEPLOY_REGION=us-east-1
dev-auth-config:
	@set -e; \
	$(resolve_output_fn); \
	POOL=$$(resolve_output UserPoolId); CLIENT=$$(resolve_output UserPoolClientId); \
	if [ -z "$$CLIENT" ] || [ "$$CLIENT" = "None" ]; then \
		echo "dev-auth-config: stack '$(STACK_NAME)' has no UserPoolClientId output" >&2; exit 1; \
	fi; \
	REGION="$(or $(DEPLOY_REGION),$${AWS_REGION:-us-east-1})"; \
	printf '{"region":"%s","userPoolId":"%s","clientId":"%s"}\n' "$$REGION" "$$POOL" "$$CLIENT" > app/public/auth-config.json; \
	echo "dev-auth-config: wrote app/public/auth-config.json for $(STACK_NAME)"

# --------------------------------------------------------------------------- #
# install / lint / test (the same scripts CI runs)
# --------------------------------------------------------------------------- #

install:
	npm ci

lint:
	npm run format:check
	npm run lint

typecheck:
	npm run typecheck

test:
	npm test

test-coverage:
	npm run test:coverage

# cfn-lint via sam: no AWS credentials needed. CI runs the same target.
validate-template:
	cd infra && sam validate --lint --region $(or $(DEPLOY_REGION),us-east-1)

# Playwright boots its own Vite dev server (app/playwright.config.ts).
e2e:
	npm run e2e --workspace=app

# Anonymous post-deploy checks against a deployed URL. No AWS credentials.
#   make smoke URL=https://fantasy.readysetcloud.io
smoke:
	@if [ -z "$(URL)" ]; then echo "smoke: URL is required, e.g. make smoke URL=https://..." >&2; exit 1; fi
	node scripts/deploy-smoke.mjs --url "$(URL)"

# --------------------------------------------------------------------------- #
# deploy
#
# Two halves, one definition, shared by local runs and CI (.github/workflows):
#
#   deploy-backend   bundle the API (scripts/package-server.sh) -> upload to
#                    the stack's ArtifactBucket -> sam deploy the whole stack
#   deploy-frontend  build the SPA -> write /auth-config.json from the stack's
#                    outputs -> s3 sync -> CloudFront invalidation
#   deploy           both, in that order
#
# The artifact key is content-hashed and always passed to `sam deploy`: the
# template's ServerArtifactKey defaults to '', and '' deletes the API, the SPA
# bucket and the distribution. Never run a bare `sam deploy` against a
# deployed stack for that reason.
#
# Optional overrides:
#   SERVER_MEMORY=2048 make deploy-backend
#   make deploy-backend APP_DOMAIN_NAME=fantasy.readysetcloud.io APP_HOSTED_ZONE_ID=Z123...
#       # serve on a custom domain (production passes these). Left off, a
#       # deploy keeps whatever the stack has -- sam deploy reuses the previous
#       # value of any parameter it is not given. To remove the domain, set
#       # both empty: make deploy-backend APP_DOMAIN_NAME= APP_HOSTED_ZONE_ID=
# --------------------------------------------------------------------------- #

package-server:
	SERVER_BUILD_DIR=$(SERVER_BUILD_DIR) ./scripts/package-server.sh

# `Name=Value` for a custom-domain parameter the caller set, `Name=""` when
# they set it empty, nothing when they did not set it at all. The quotes
# matter: sam parses a bare `Name=` as no override (so the previous value is
# kept), and only `Name=""` as an explicit empty value.
domain_override = $(if $(filter undefined,$(origin $(2))),,$(if $($(2)),"$(1)=$($(2))",'$(1)=""'))

deploy-backend:
	@set -e; \
	$(resolve_output_fn); \
	$(ensure_origin_secret_fn); \
	ensure_origin_secret; \
	STATUS=$$(aws cloudformation describe-stacks --stack-name $(STACK_NAME) $(REGION_ARG) \
		--query 'Stacks[0].StackStatus' --output text 2>/dev/null || true); \
	if [ "$$STATUS" = "ROLLBACK_COMPLETE" ]; then \
		echo "deploy-backend: stack '$(STACK_NAME)' is ROLLBACK_COMPLETE (its first create failed) -- deleting it so it can be recreated"; \
		aws cloudformation delete-stack --stack-name $(STACK_NAME) $(REGION_ARG); \
		aws cloudformation wait stack-delete-complete --stack-name $(STACK_NAME) $(REGION_ARG); \
	fi; \
	SERVER_BUILD_DIR=$(SERVER_BUILD_DIR) ./scripts/package-server.sh; \
	. $(SERVER_BUILD_DIR)/artifact.env; SERVER_KEY="$$ARTIFACT_KEY"; SERVER_ZIP="$$ARTIFACT_ZIP"; \
	BUCKET=$$(resolve_output ArtifactBucket); \
	if [ -z "$$BUCKET" ] || [ "$$BUCKET" = "None" ]; then \
		echo "deploy-backend: stack '$(STACK_NAME)' has no artifact bucket yet -- bootstrapping"; \
		( cd infra && sam build && sam deploy $(SAM_DEPLOY_ARGS) --parameter-overrides $(ORIGIN_SECRET_OVERRIDES) ); \
		BUCKET=$$(resolve_output ArtifactBucket); \
	fi; \
	if [ -z "$$BUCKET" ] || [ "$$BUCKET" = "None" ]; then \
		echo "deploy-backend: could not resolve ArtifactBucket from stack '$(STACK_NAME)'" >&2; \
		exit 1; \
	fi; \
	echo "deploy-backend: uploading $$SERVER_KEY to s3://$$BUCKET"; \
	aws s3 cp "$$SERVER_ZIP" "s3://$$BUCKET/$$SERVER_KEY" $(REGION_ARG); \
	( cd infra && sam build && sam deploy $(SAM_DEPLOY_ARGS) --parameter-overrides \
		"ServerArtifactKey=$$SERVER_KEY" \
		$(ORIGIN_SECRET_OVERRIDES) \
		$${SERVER_MEMORY:+"ServerMemorySize=$$SERVER_MEMORY"} \
		$(call domain_override,AppDomainName,APP_DOMAIN_NAME) \
		$(call domain_override,AppHostedZoneId,APP_HOSTED_ZONE_ID) ); \
	echo; \
	echo "Backend deployed to stack $(STACK_NAME):"; \
	echo "  AppUrl:           $$(resolve_output AppUrl)"; \
	echo "  TableName:        $$(resolve_output TableName)"; \
	echo "  UserPoolClientId: $$(resolve_output UserPoolClientId)"

deploy-frontend:
	@set -e; \
	$(resolve_output_fn); \
	APP_BUCKET=$$(resolve_output AppBucket); \
	DIST_ID=$$(resolve_output AppDistributionId); \
	APP_URL=$$(resolve_output AppUrl); \
	POOL_ID=$$(resolve_output UserPoolId); \
	CLIENT_ID=$$(resolve_output UserPoolClientId); \
	if [ -z "$$APP_BUCKET" ] || [ "$$APP_BUCKET" = "None" ]; then \
		echo "deploy-frontend: stack '$(STACK_NAME)' has no AppBucket output -- run make deploy-backend first" >&2; \
		exit 1; \
	fi; \
	REGION="$(or $(DEPLOY_REGION),$${AWS_REGION:-$${AWS_DEFAULT_REGION:-us-east-1}})"; \
	echo "deploy-frontend: building the SPA"; \
	npm ci; \
	npm run build --workspace=app; \
	printf '{"region":"%s","userPoolId":"%s","clientId":"%s"}\n' "$$REGION" "$$POOL_ID" "$$CLIENT_ID" > app/dist/auth-config.json; \
	echo "deploy-frontend: publishing to s3://$$APP_BUCKET"; \
	aws s3 sync app/dist "s3://$$APP_BUCKET" --delete $(REGION_ARG) \
		--exclude index.html --exclude auth-config.json \
		--cache-control 'public, max-age=31536000, immutable'; \
	aws s3 cp app/dist/index.html "s3://$$APP_BUCKET/index.html" $(REGION_ARG) \
		--cache-control 'no-cache' --content-type 'text/html; charset=utf-8'; \
	aws s3 cp app/dist/auth-config.json "s3://$$APP_BUCKET/auth-config.json" $(REGION_ARG) \
		--cache-control 'no-cache' --content-type 'application/json'; \
	echo "deploy-frontend: invalidating $$DIST_ID"; \
	aws cloudfront create-invalidation --distribution-id "$$DIST_ID" --paths '/*' >/dev/null; \
	echo; \
	echo "Deployed: $$APP_URL"; \
	echo "Function URL: $$(resolve_output ApiFunctionUrl)"

# Rotate the CloudFront origin-verify secret with no downtime: the current
# value becomes the previous one (still accepted by the API), a new current is
# generated, and the next `make deploy-backend` rolls both out -- the Lambda
# first, then the distribution. Rotate again only after that deploy finishes.
rotate-origin-secret:
	@set -e; \
	current=$$(aws ssm get-parameter --name "$(ORIGIN_SECRET_PREFIX)/current" $(REGION_ARG) \
		--query Parameter.Value --output text); \
	aws ssm put-parameter --name "$(ORIGIN_SECRET_PREFIX)/previous" --type String --overwrite \
		--value "$$current" $(REGION_ARG) >/dev/null; \
	aws ssm put-parameter --name "$(ORIGIN_SECRET_PREFIX)/current" --type String --overwrite \
		--value "$$(openssl rand -hex 32)" $(REGION_ARG) >/dev/null; \
	echo "rotate-origin-secret: rotated $(ORIGIN_SECRET_PREFIX); run make deploy-backend to roll it out"

deploy: deploy-backend deploy-frontend

# Tear the stack down. Guarded behind CONFIRM= because it deletes the API, the
# SPA bucket and the distribution. The league table is RETAINED (DeletionPolicy)
# and survives; delete it by hand if you really mean to.
#
# CloudFormation refuses to delete a non-empty bucket, and ArtifactBucket is
# versioned, so every object version and delete marker has to go first.
destroy:
	@set -e; \
	if [ "$(CONFIRM)" != "$(STACK_NAME)" ]; then \
		echo "destroy: this DELETES the stack '$(STACK_NAME)' (API, SPA bucket, artifact bucket)."; \
		echo "         The league table is retained."; \
		echo; \
		echo "  make destroy CONFIRM=$(STACK_NAME)"; \
		exit 1; \
	fi; \
	$(resolve_output_fn); \
	empty_bucket() { \
		bucket="$$1"; \
		if [ -z "$$bucket" ] || [ "$$bucket" = "None" ]; then return 0; fi; \
		echo "==> emptying s3://$$bucket (including every version)"; \
		aws s3 rm "s3://$$bucket" --recursive $(REGION_ARG) >/dev/null 2>&1 || true; \
		while :; do \
			versions=$$(aws s3api list-object-versions --bucket "$$bucket" $(REGION_ARG) --max-items 500 \
				--query '{Objects: Versions[].{Key:Key,VersionId:VersionId}}' --output json 2>/dev/null || echo '{"Objects":null}'); \
			markers=$$(aws s3api list-object-versions --bucket "$$bucket" $(REGION_ARG) --max-items 500 \
				--query '{Objects: DeleteMarkers[].{Key:Key,VersionId:VersionId}}' --output json 2>/dev/null || echo '{"Objects":null}'); \
			done_versions=1; \
			case "$$versions" in *'"Objects": null'*|*'"Objects":null'*) ;; *) \
				aws s3api delete-objects --bucket "$$bucket" $(REGION_ARG) --delete "$$versions" >/dev/null; done_versions=0 ;; \
			esac; \
			case "$$markers" in *'"Objects": null'*|*'"Objects":null'*) ;; *) \
				aws s3api delete-objects --bucket "$$bucket" $(REGION_ARG) --delete "$$markers" >/dev/null; done_versions=0 ;; \
			esac; \
			if [ "$$done_versions" = "1" ]; then break; fi; \
		done; \
	}; \
	empty_bucket "$$(resolve_output AppBucket)"; \
	empty_bucket "$$(resolve_output ArtifactBucket)"; \
	echo "==> deleting stack $(STACK_NAME)"; \
	aws cloudformation delete-stack --stack-name $(STACK_NAME) $(REGION_ARG); \
	aws cloudformation wait stack-delete-complete --stack-name $(STACK_NAME) $(REGION_ARG); \
	echo "==> $(STACK_NAME) deleted"
