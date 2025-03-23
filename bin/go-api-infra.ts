#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';

import { GoApiInfraStack } from '../lib/go-api-infra-stack'; // staging stack
import { GoApiProdInfraStack } from '../lib/go-api-prod-infra-stack'; // production stack

const app = new cdk.App();

// Instantiate your staging environment (if needed)

new GoApiInfraStack(app, 'GoApiStagingInfraStack');

// Instantiate your production environment
new GoApiProdInfraStack(app, 'GoApiProdInfraStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION
  },
});

