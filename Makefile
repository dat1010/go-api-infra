STACK ?= GoApiInfraStack

.PHONY: ssm
ssm:
	aws ssm start-session --target $(shell aws cloudformation describe-stacks --stack-name $(STACK) --query "Stacks[0].Outputs[?OutputKey=='BastionInstanceId'].OutputValue" --output text)
