FROM node:22-bookworm-slim

WORKDIR /app

RUN corepack enable

COPY package.json yarn.lock .pnp.cjs .pnp.loader.mjs ./
COPY .yarn ./.yarn

RUN yarn install --immutable

COPY tsconfig.json nest-cli.json ./
COPY prisma ./prisma
COPY generated ./generated
COPY src ./src

RUN yarn build

EXPOSE 3001

CMD ["yarn", "start"]
