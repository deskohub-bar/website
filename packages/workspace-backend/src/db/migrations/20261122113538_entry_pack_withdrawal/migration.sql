ALTER TABLE "contract_withdrawals" DROP CONSTRAINT "contract_withdrawals_refund_basis_check", ADD CONSTRAINT "contract_withdrawals_refund_basis_check" CHECK (("refund_unit" is null and "refund_unstarted_units" is null and "refund_total_units" is null and "refund_amount_value" = "paid_amount_value")
        or (("refund_unit" in ('day', 'hour') or ("contract_kind" = 'entry-pack' and "refund_unit" = 'entry'))
          and ("refund_unstarted_units" > 0
            or ((("contract_kind" = 'unlimited-pass' and "refund_unit" = 'day')
              or ("contract_kind" = 'entry-pack' and "refund_unit" = 'entry'))
              and "refund_unstarted_units" = 0 and "refund_amount_value" = 0))
          and "refund_total_units" > "refund_unstarted_units"));