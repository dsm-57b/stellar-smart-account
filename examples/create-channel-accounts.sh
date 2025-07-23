#!/bin/bash

# Automatic Channel Account Creator
# Creates channel accounts in batches of 19 until reaching the desired count

DESIRED_COUNT=${1:-100}
BATCH_SIZE=19

echo "🚀 Creating $DESIRED_COUNT channel accounts in batches of $BATCH_SIZE"

# Check current count
CURRENT_COUNT=$(docker exec wallet-backend-db-1 psql -U postgres -d wallet-backend -t -c "SELECT COUNT(*) FROM channel_accounts;" | tr -d ' ')

echo "📊 Current channel accounts: $CURRENT_COUNT"
echo "🎯 Target channel accounts: $DESIRED_COUNT"

if [ "$CURRENT_COUNT" -ge "$DESIRED_COUNT" ]; then
    echo "✅ Already have $CURRENT_COUNT accounts (>= $DESIRED_COUNT), no action needed"
    exit 0
fi

REMAINING=$((DESIRED_COUNT - CURRENT_COUNT))
echo "🔧 Need to create: $REMAINING more accounts"

while [ "$CURRENT_COUNT" -lt "$DESIRED_COUNT" ]; do
    REMAINING=$((DESIRED_COUNT - CURRENT_COUNT))
    
    if [ "$REMAINING" -gt "$BATCH_SIZE" ]; then
        NEXT_TARGET=$((CURRENT_COUNT + BATCH_SIZE))
    else
        NEXT_TARGET=$DESIRED_COUNT
    fi
    
    CREATING=$((NEXT_TARGET - CURRENT_COUNT))
    
    echo ""
    echo "📦 Creating batch: $CREATING accounts (total will be $NEXT_TARGET)"
    
    # Create the batch
    if docker exec wallet-backend-api-1 ./wallet-backend channel-account ensure $NEXT_TARGET; then
        echo "✅ Successfully created batch"
        CURRENT_COUNT=$NEXT_TARGET
        
        # Brief pause between batches
        if [ "$CURRENT_COUNT" -lt "$DESIRED_COUNT" ]; then
            echo "⏳ Waiting 3 seconds before next batch..."
            sleep 3
        fi
    else
        echo "❌ Failed to create batch, stopping"
        exit 1
    fi
done

echo ""
echo "🎉 Successfully created all channel accounts!"
echo "📊 Final count: $CURRENT_COUNT channel accounts"

# Verify final count
FINAL_COUNT=$(docker exec wallet-backend-db-1 psql -U postgres -d wallet-backend -t -c "SELECT COUNT(*) FROM channel_accounts;" | tr -d ' ')
echo "✅ Verified count: $FINAL_COUNT channel accounts" 