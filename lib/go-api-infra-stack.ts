import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecsPatterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

export class GoApiInfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // 1) VPC with only public subnets (no NAT Gateways)
    const vpc = new ec2.Vpc(this, 'GoApiVpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
      ],
    });

    // 2) ECS Cluster in that VPC
    const cluster = new ecs.Cluster(this, 'GoApiCluster', { vpc });

    // 3) Lambda function (unchanged)
    const processDataLambda = new lambda.Function(this, 'ProcessDataLambda', {
      runtime: lambda.Runtime.PYTHON_3_11,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda'),
    });

    processDataLambda.addPermission('AllowEventBridgeInvoke', {
      principal: new iam.ServicePrincipal('events.amazonaws.com'),
      action: 'lambda:InvokeFunction',
      sourceArn: `arn:aws:events:${this.region}:${this.account}:rule/*`,
    });

    // 4) Reference existing ACM certificate
    const certificate = acm.Certificate.fromCertificateArn(
      this,
      'APICertificate',
      'arn:aws:acm:us-east-1:069597727371:certificate/146132c0-6175-4ce3-8edf-0d4108d53287'
    );

    const authConfigSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'GoApiAuthConfigSecret',
      'staging/go-api'
    );

    // 5) Fargate Service in public subnets—with public IPs
    const fargateService = new ecsPatterns.ApplicationLoadBalancedFargateService(
      this,
      'GoApiFargateService',
      {
        cluster,
        cpu: 256,
        memoryLimitMiB: 512,
        desiredCount: 1,
        publicLoadBalancer: true,
        taskSubnets: { subnetType: ec2.SubnetType.PUBLIC },
        assignPublicIp: true,
        taskImageOptions: {
          image: ecs.ContainerImage.fromRegistry(
            '069597727371.dkr.ecr.us-east-1.amazonaws.com/go-api:latest'
          ),
          containerPort: 8080,
          secrets: {
            AUTH0_AUDIENCE: ecs.Secret.fromSecretsManager(authConfigSecret, 'AUTH0_AUDIENCE'),
            AUTH0_DOMAIN: ecs.Secret.fromSecretsManager(authConfigSecret, 'AUTH0_DOMAIN'),
            AUTH0_CALLBACK_URL: ecs.Secret.fromSecretsManager(
              authConfigSecret,
              'AUTH0_CALLBACK_URL'
            ),
            AUTH0_CLIENT_ID: ecs.Secret.fromSecretsManager(
              authConfigSecret,
              'AUTH0_CLIENT_ID'
            ),
            AUTH0_CLIENT_SECRET: ecs.Secret.fromSecretsManager(
              authConfigSecret,
              'AUTH0_CLIENT_SECRET'
            ),
            AUTH0_LOGOUT_RETURN_URL: ecs.Secret.fromSecretsManager(
              authConfigSecret,
              'AUTH0_LOGOUT_RETURN_URL'
            ),
          },
        },
        certificate,
        redirectHTTP: true,
      }
    );

    // 5a) RDS PostgreSQL db.t4g.micro in public subnets (no public access)
    const dbSecurityGroup = new ec2.SecurityGroup(this, 'GoApiDbSecurityGroup', {
      vpc,
      description: 'Security group for RDS Postgres',
      allowAllOutbound: true,
    });

    const dbCredentials = rds.Credentials.fromGeneratedSecret('dbadmin');

    const dbInstance = new rds.DatabaseInstance(this, 'GoApiPostgresInstance', {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_15,
      }),
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.BURSTABLE4_GRAVITON,
        ec2.InstanceSize.MICRO
      ),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [dbSecurityGroup],
      credentials: dbCredentials,
      databaseName: 'nofeed',
      allocatedStorage: 20,
      storageType: rds.StorageType.GP3,
      multiAz: false,
      publiclyAccessible: false,
      backupRetention: cdk.Duration.days(1),
      deletionProtection: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Allow ECS tasks to connect to the DB
    dbInstance.connections.allowDefaultPortFrom(fargateService.service, 'ECS to RDS');

    if (dbInstance.secret) {
      fargateService.taskDefinition.defaultContainer?.addEnvironment(
        'DB_SECRET_ARN',
        dbInstance.secret.secretArn
      );
      dbInstance.secret.grantRead(fargateService.taskDefinition.taskRole);
    }

    // 5b) SSM-only bastion host (no inbound rules)
    const bastionSecurityGroup = new ec2.SecurityGroup(this, 'GoApiBastionSecurityGroup', {
      vpc,
      description: 'Security group for SSM bastion',
      allowAllOutbound: true,
    });

    const bastionRole = new iam.Role(this, 'GoApiBastionRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
    });
    bastionRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')
    );

    const bastion = new ec2.Instance(this, 'GoApiBastion', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.NANO),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      securityGroup: bastionSecurityGroup,
      role: bastionRole,
    });

    // Install psql client
    bastion.addUserData('dnf install -y postgresql15');

    // Allow bastion to connect to the DB
    dbInstance.connections.allowDefaultPortFrom(bastion, 'Bastion to RDS');
    if (dbInstance.secret) {
      dbInstance.secret.grantRead(bastionRole);
    }

    fargateService.targetGroup.configureHealthCheck({
      path: '/api/healthcheck',
      interval: cdk.Duration.seconds(30),
      timeout: cdk.Duration.seconds(5),
      healthyThresholdCount: 2,
      unhealthyThresholdCount: 5,
    });

    // 6) ECR & SecretsManager permissions (unchanged)
    fargateService.taskDefinition.addToExecutionRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'ecr:GetAuthorizationToken',
          'ecr:BatchCheckLayerAvailability',
          'ecr:GetDownloadUrlForLayer',
          'ecr:BatchGetImage',
        ],
        resources: ['*'],
      })
    );

    fargateService.taskDefinition.addToExecutionRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['secretsmanager:GetSecretValue'],
        resources: [authConfigSecret.secretArn],
      })
    );

    authConfigSecret.grantRead(fargateService.taskDefinition.executionRole!);

    fargateService.taskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['events:PutRule', 'events:PutTargets', 'events:ListRules', 'events:ListTargetsByRule'],
        resources: [`arn:aws:events:${this.region}:${this.account}:rule/*`],
      })
    );

    // 7) Outputs
    new cdk.CfnOutput(this, 'LoadBalancerDNS', {
      value: fargateService.loadBalancer.loadBalancerDnsName,
    });

    new cdk.CfnOutput(this, 'LambdaARN', {
      value: processDataLambda.functionArn,
      description: 'ARN of the Process Data Lambda function',
    });

    new cdk.CfnOutput(this, 'PostgresEndpoint', {
      value: dbInstance.instanceEndpoint.hostname,
    });

    if (dbInstance.secret) {
      new cdk.CfnOutput(this, 'PostgresSecretArn', {
        value: dbInstance.secret.secretArn,
      });
    }

    new cdk.CfnOutput(this, 'BastionInstanceId', {
      value: bastion.instanceId,
    });
  }
}
