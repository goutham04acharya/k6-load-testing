# Shared settings for the admin scripts. Override with environment variables.
export AWS_PROFILE="${AWS_PROFILE:-goutham-iam}"
export AWS_REGION="${AWS_REGION:-ap-south-1}"
export AWS_DEFAULT_REGION="$AWS_REGION"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TABLE="${TABLE:-k6kt}"
tf_out() { terraform -chdir="$ROOT/terraform" output -raw "$1"; }
