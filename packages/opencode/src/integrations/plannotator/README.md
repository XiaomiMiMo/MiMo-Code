# Plannotator Integration for MiMo-Code

This module integrates [Plannotator](https://github.com/backnotprop/plannotator) into MiMo-Code as a human-in-the-loop review layer.

## Components

- `exporter.ts`: Converts MiMo plans to Plannotator-compatible Markdown.
- `importer.ts`: Parses Plannotator feedback and approval status.
- `review_client.ts`: Handles CLI communication with Plannotator.
- `hooks.ts`: Provides integration points for the planning and execution workflows.

## Workflow

1. **Plan Review**: Before executing a plan, it is sent to Plannotator for human approval.
2. **Code Review**: After implementation, the changes (git diff) are sent to Plannotator for review.
3. **Dataset Generation**: All reviews and feedback are stored in `datasets/plannotator_feedback/` for future model fine-tuning.

## Usage

The integration is designed to be used within MiMo-Code's `compose` skills or workflows.
