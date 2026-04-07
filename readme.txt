UPDATE users SET boost_charges = 1 WHERE boost_charges IS NULL OR boost_charges = 0;
UPDATE users SET turbo_charges = 1 WHERE turbo_charges IS NULL OR turbo_charges = 0;
 



The frontend expects one free surge for all. manually use thus qouery to add it 