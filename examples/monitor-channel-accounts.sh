#!/bin/bash

# Real-Time Channel Account Monitor
# Shows live channel account usage during scalability tests

REFRESH_INTERVAL=${1:-5}

echo "🔍 REAL-TIME CHANNEL ACCOUNT MONITOR"
echo "======================================="
echo "Press Ctrl+C to stop monitoring"
echo ""

# Function to get status
get_status() {
    # Get counts
    TOTAL=$(docker exec wallet-backend-db-1 psql -U postgres -d wallet-backend -t -c "SELECT COUNT(*) FROM channel_accounts;" 2>/dev/null | tr -d ' ')
    LOCKED=$(docker exec wallet-backend-db-1 psql -U postgres -d wallet-backend -t -c "SELECT COUNT(*) FROM channel_accounts WHERE locked_at IS NOT NULL AND locked_until > NOW();" 2>/dev/null | tr -d ' ')
    AVAILABLE=$((TOTAL - LOCKED))
    
    # Get oldest lock expiry
    OLDEST_EXPIRY=$(docker exec wallet-backend-db-1 psql -U postgres -d wallet-backend -t -c "SELECT MIN(locked_until) FROM channel_accounts WHERE locked_at IS NOT NULL AND locked_until > NOW();" 2>/dev/null | tr -d ' ')
    
    # Current timestamp
    TIMESTAMP=$(date '+%H:%M:%S')
    
    # Calculate percentages
    if [ "$TOTAL" -gt 0 ]; then
        LOCKED_PCT=$((LOCKED * 100 / TOTAL))
        AVAILABLE_PCT=$((AVAILABLE * 100 / TOTAL))
    else
        LOCKED_PCT=0
        AVAILABLE_PCT=0
    fi
    
    # Status indicator
    if [ "$AVAILABLE" -ge 20 ]; then
        STATUS="🟢 EXCELLENT"
    elif [ "$AVAILABLE" -ge 10 ]; then
        STATUS="🟡 MODERATE"
    elif [ "$AVAILABLE" -ge 5 ]; then
        STATUS="🟠 LIMITED"
    else
        STATUS="🔴 CRITICAL"
    fi
    
    echo "[$TIMESTAMP] $STATUS | Total: $TOTAL | Available: $AVAILABLE ($AVAILABLE_PCT%) | Locked: $LOCKED ($LOCKED_PCT%)"
    
    if [ "$OLDEST_EXPIRY" != "" ] && [ "$OLDEST_EXPIRY" != "null" ]; then
        echo "             ⏰ Next unlock: $OLDEST_EXPIRY"
    fi
    
    # Show recent activity
    RECENT_LOCKS=$(docker exec wallet-backend-db-1 psql -U postgres -d wallet-backend -t -c "SELECT COUNT(*) FROM channel_accounts WHERE locked_at > NOW() - INTERVAL '30 seconds';" 2>/dev/null | tr -d ' ')
    if [ "$RECENT_LOCKS" -gt 0 ]; then
        echo "             🔄 $RECENT_LOCKS accounts locked in last 30s"
    fi
}

# Trap Ctrl+C
trap 'echo ""; echo "👋 Monitoring stopped"; exit 0' INT

# Main monitoring loop
while true; do
    clear
    echo "🔍 REAL-TIME CHANNEL ACCOUNT MONITOR (refresh: ${REFRESH_INTERVAL}s)"
    echo "================================================================"
    echo ""
    
    get_status
    
    echo ""
    echo "💡 USAGE TIPS:"
    echo "   - Green (≥20 available): Can handle 8-10 parallel wallets"
    echo "   - Yellow (≥10 available): Can handle 4-5 parallel wallets"  
    echo "   - Orange (≥5 available): Can handle 2-3 parallel wallets"
    echo "   - Red (<5 available): Risk of channel exhaustion"
    echo ""
    echo "Press Ctrl+C to stop monitoring"
    
    sleep $REFRESH_INTERVAL
done 