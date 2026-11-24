# Shared settings for the admin scripts. Override with environment variables.
export AWS_PROFILE="${AWS_PROFILE:-goutham-iam}"
export AWS_REGION="${AWS_REGION:-ap-south-1}"
export AWS_DEFAULT_REGION="$AWS_REGION"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TF_DIR="$REPO_ROOT/terraform"
tf_out() { terraform -chdir="$TF_DIR" output -raw "$1"; }
TABLE="${TABLE:-$(tf_out table_name)}"
