import { mergeResponseFacts } from '../core/conversation-responses.js';

function toolInput(customerId, context, suffix) {
  return {
    customer_id: customerId,
    ...(context?.subscription_id ? { subscription_id: context.subscription_id } : {}),
    idempotency_key: `${context.idempotency_key}:${suffix}`,
    correlation_id: context.correlation_id
  };
}

function renewalFacts(facts, result = {}) {
  return mergeResponseFacts(facts, {
    payment_status: result.payment_status ?? facts.payment_status,
    renewal_status: result.renewal_status ?? result.state ?? facts.renewal_status,
    expiration: result.target_expiration ?? result.expires_at ?? facts.expiration,
    operation_state: result.decision || result.status || null
  });
}

export class RenewalAgent {
  async handle({ intentResult, customerId, customer360, turn, facts, context }) {
    const intents = new Set(intentResult.intents.map((item) => item.name));
    const subscriptionId = customer360?.subscription?.subscription_id || null;
    const scopedContext = { ...context, subscription_id: subscriptionId };

    if (intents.has('EXPIRATION_QUERY')) {
      const expiration = await turn.execute('getExpiration', { customer_id: customerId });
      return {
        handled: true,
        proposed_action: 'getExpiration',
        facts: mergeResponseFacts(facts, { expiration: expiration.expires_at || null })
      };
    }

    if (intents.has('SUBSCRIPTION_QUERY')) {
      const subscription = await turn.execute('getSubscription', { customer_id: customerId });
      return {
        handled: true,
        proposed_action: 'getSubscription',
        facts: mergeResponseFacts(facts, {
          plan_name: subscription.plan_name || facts.plan_name,
          subscription_status: subscription.status || null,
          expiration: subscription.expires_at || null
        })
      };
    }

    if (intents.has('PLAN_QUERY')) {
      const plans = await turn.execute('listPlans', {});
      return {
        handled: true,
        proposed_action: 'listPlans',
        facts: mergeResponseFacts(facts, { plans })
      };
    }

    if (intents.has('PAYMENT_STATUS') || intents.has('PAYMENT_EVIDENCE')) {
      const payment = await turn.execute('getPaymentStatus', {
        customer_id: customerId,
        ...(subscriptionId ? { subscription_id: subscriptionId } : {})
      });
      let nextFacts = mergeResponseFacts(facts, { payment_status: payment.status || null });
      if (payment.status === 'CONFIRMED' || intents.has('RENEWAL_STATUS')) {
        const renewal = await turn.execute('getRenewalStatus', {
          customer_id: customerId,
          ...(subscriptionId ? { subscription_id: subscriptionId } : {})
        });
        nextFacts = renewalFacts(nextFacts, renewal);
      }
      return { handled: true, proposed_action: 'getPaymentStatus', facts: nextFacts };
    }

    if (intents.has('RENEWAL_STATUS')) {
      const status = await turn.execute('getRenewalStatus', {
        customer_id: customerId,
        ...(subscriptionId ? { subscription_id: subscriptionId } : {})
      });
      return { handled: true, proposed_action: 'getRenewalStatus', facts: renewalFacts(facts, status) };
    }

    if (intents.has('RENEWAL_REQUEST') || intents.has('PAYMENT_REQUEST')) {
      const subscription = await turn.execute('getSubscription', { customer_id: customerId });
      const renewal = await turn.execute('getRenewalStatus', {
        customer_id: customerId,
        subscription_id: subscription.subscription_id
      });
      let nextFacts = renewalFacts(facts, renewal);
      if (renewal.decision !== 'PAYMENT_REQUIRED') {
        if (renewal.decision === 'PAYMENT_PENDING') {
          const payment = await turn.execute('getPaymentStatus', {
            customer_id: customerId,
            subscription_id: subscription.subscription_id
          });
          nextFacts = mergeResponseFacts(nextFacts, { payment_status: payment.status || 'PENDING' });
        }
        return { handled: true, proposed_action: 'getRenewalStatus', facts: nextFacts };
      }

      const requested = await turn.execute('requestRenewal', toolInput(customerId, {
        ...scopedContext,
        subscription_id: subscription.subscription_id
      }, 'renewal'));
      nextFacts = renewalFacts(nextFacts, requested);
      if (requested.decision && requested.decision !== 'PAYMENT_REQUIRED') {
        return { handled: true, proposed_action: 'requestRenewal', facts: nextFacts };
      }

      const payment = await turn.execute('createPaymentRequest', {
        ...toolInput(customerId, {
          ...scopedContext,
          subscription_id: subscription.subscription_id
        }, 'payment'),
        ...(context.plan_code ? { plan_code: context.plan_code } : {})
      });
      return {
        handled: true,
        proposed_action: 'createPaymentRequest',
        facts: mergeResponseFacts(nextFacts, {
          payment_status: payment.status || 'PENDING',
          checkout_url: payment.checkout_url || null,
          amount_cents: payment.amount_cents ?? null,
          currency: payment.currency || 'BRL',
          operation_state: payment.existing ? 'EXISTING_PAYMENT' : 'PAYMENT_CREATED'
        })
      };
    }

    return { handled: false, proposed_action: null, facts };
  }
}
