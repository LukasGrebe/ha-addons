#!/bin/sh
# GIT_ASKPASS helper: answers git's credential prompts for HTTPS remotes with the
# token from the app configuration (GIT_TOKEN), so that no credentials are stored
# in the repository or in a credential store.
case "$1" in
    Username*) echo "${GIT_USERNAME:-x-access-token}" ;;
    *) echo "${GIT_TOKEN:-}" ;;
esac
